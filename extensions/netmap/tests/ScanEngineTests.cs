using System.Net;
using Amazon.Runtime;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class ScanEngineTests
{
    private sealed class FakeClock
    {
        public DateTime Now = new(2026, 10, 16, 9, 0, 0, DateTimeKind.Utc);
        public DateTime Get() => Now;
    }

    private sealed class FakeExecutor : IUnitExecutor
    {
        public Func<WorkUnit, IReadOnlyList<GraphPart>, GraphPart> Behaviour = (_, _) => new GraphPart();
        public List<(string Unit, int Priors)> Calls { get; } = new();
        public Task<GraphPart> ExecuteAsync(WorkUnit unit, IReadOnlyList<GraphPart> priors, CancellationToken ct)
        {
            Calls.Add((unit.Id, priors.Count));
            return Task.FromResult(Behaviour(unit, priors));
        }
    }

    private static List<WorkUnit> Units(params (string Scope, string Region)[] groups) =>
        ScanPlanner.Plan(groups.Select((g, i) => new BlueprintMember { ScopeId = g.Scope, Region = g.Region, NetworkId = $"vpc-{i}" }),
            new[] { Collectors.CoreNetwork, Collectors.Transit, Collectors.DnsZones });

    private static AmazonServiceException Aws(string code, string message, HttpStatusCode status = HttpStatusCode.BadRequest) =>
        new(message, null, ErrorType.Sender, code, "req-1", status);

    [Fact]
    public async Task Runs_all_pending_units_persisting_each_and_feeding_scope_priors()
    {
        var units = Units(("net", "us-east-1"), ("prod", "us-east-1"));
        var exec = new FakeExecutor();
        var persisted = new List<string>();

        var result = await new ScanEngine().RunTickAsync(units, exec, u => { persisted.Add(u.Id); return Task.CompletedTask; }, CancellationToken.None);

        result.Pending.Should().Be(0);
        persisted.Should().HaveCount(units.Count);
        units.Should().OnlyContain(u => u.Status == UnitStatuses.Done && u.Part != null);
        exec.Calls.Single(c => c.Unit == "aws.transit|net|us-east-1").Priors.Should().Be(1);   // core of the same group only
        exec.Calls.Single(c => c.Unit == "aws.dns-zones|net|global").Priors.Should().Be(2);    // every done unit of the scope
    }

    [Fact]
    public async Task Stops_starting_units_once_the_budget_is_spent_and_resumes_next_tick()
    {
        var clock = new FakeClock();
        var units = Units(("net", "us-east-1"));
        var exec = new FakeExecutor { Behaviour = (_, _) => { clock.Now = clock.Now.AddSeconds(40); return new GraphPart(); } };
        var engine = new ScanEngine(clock.Get);

        var first = await engine.RunTickAsync(units, exec, _ => Task.CompletedTask, CancellationToken.None);
        first.Executed.Should().Be(2);
        first.Pending.Should().Be(1);
        first.BudgetExhausted.Should().BeTrue();

        var second = await engine.RunTickAsync(units, exec, _ => Task.CompletedTask, CancellationToken.None);
        second.Pending.Should().Be(0);
    }

    [Fact]
    public async Task Denied_is_terminal_and_records_the_missing_permission()
    {
        var units = Units(("net", "us-east-1"));
        var exec = new FakeExecutor
        {
            Behaviour = (u, _) => u.Collector == Collectors.Transit.Id
                ? throw Aws("UnauthorizedOperation", "You are not authorized to perform this operation. User: arn:x is not authorized to perform: ec2:DescribeTransitGatewayRouteTables on resource: *")
                : new GraphPart(),
        };

        await new ScanEngine().RunTickAsync(units, exec, _ => Task.CompletedTask, CancellationToken.None);

        var t = units.Single(u => u.Collector == Collectors.Transit.Id);
        t.Status.Should().Be(UnitStatuses.Denied);
        t.MissingPermission.Should().Be("ec2:DescribeTransitGatewayRouteTables");
        units.Where(u => u != t).Should().OnlyContain(u => u.Status == UnitStatuses.Done);
    }

    [Fact]
    public async Task Transient_errors_retry_on_later_ticks_then_fail_after_three_attempts()
    {
        var units = Units(("net", "us-east-1"));
        var exec = new FakeExecutor
        {
            Behaviour = (u, _) => u.Collector == Collectors.CoreNetwork.Id ? throw Aws("RequestLimitExceeded", "slow down") : new GraphPart(),
        };
        var engine = new ScanEngine();
        var core = units.First();

        await engine.RunTickAsync(units, exec, _ => Task.CompletedTask, CancellationToken.None);
        core.Status.Should().Be(UnitStatuses.Pending);
        core.Attempts.Should().Be(1);

        await engine.RunTickAsync(units, exec, _ => Task.CompletedTask, CancellationToken.None);
        await engine.RunTickAsync(units, exec, _ => Task.CompletedTask, CancellationToken.None);
        core.Status.Should().Be(UnitStatuses.Failed);
        core.Attempts.Should().Be(3);
        core.Error.Should().Contain("slow down");
    }

    [Theory]
    [InlineData("AccessDenied", ErrorKind.Denied)]
    [InlineData("AccessDeniedException", ErrorKind.Denied)]
    [InlineData("Throttling", ErrorKind.Transient)]
    [InlineData("InvalidVpcID.NotFound", ErrorKind.Error)]
    public void Classifies_aws_error_codes(string code, ErrorKind kind) =>
        ErrorClassifier.Classify(Aws(code, "m")).Kind.Should().Be(kind);

    [Fact]
    public void Server_errors_and_timeouts_are_transient()
    {
        ErrorClassifier.Classify(Aws("Weird", "m", HttpStatusCode.ServiceUnavailable)).Kind.Should().Be(ErrorKind.Transient);
        ErrorClassifier.Classify(new TaskCanceledException()).Kind.Should().Be(ErrorKind.Transient);
        ErrorClassifier.Classify(new InvalidOperationException()).Kind.Should().Be(ErrorKind.Error);
    }

    private sealed class BlockingExecutor : IUnitExecutor
    {
        public Func<WorkUnit, bool> Blocks = _ => false;
        public Action? OnOther;
        public async Task<GraphPart> ExecuteAsync(WorkUnit unit, IReadOnlyList<GraphPart> priors, CancellationToken ct)
        {
            if (Blocks(unit)) { await Task.Delay(Timeout.Infinite, ct); }
            OnOther?.Invoke();
            return new GraphPart();
        }
    }

    [Fact]
    public async Task Unit_timing_out_after_a_late_start_stays_pending_without_consuming_an_attempt()
    {
        var clock = new FakeClock();
        var units = Units(("net", "us-east-1"));
        var exec = new BlockingExecutor { Blocks = u => u.Collector == Collectors.Transit.Id, OnOther = () => clock.Now = clock.Now.AddMilliseconds(100) };
        var engine = new ScanEngine(clock.Get) { HardCap = TimeSpan.FromMilliseconds(300) };

        await engine.RunTickAsync(units, exec, _ => Task.CompletedTask, CancellationToken.None);

        var t = units.Single(u => u.Collector == Collectors.Transit.Id);
        t.Status.Should().Be(UnitStatuses.Pending);
        t.Attempts.Should().Be(0);
        t.Error.Should().Contain("started late");
    }

    [Fact]
    public async Task Unit_timing_out_with_the_full_cap_consumes_an_attempt()
    {
        var units = Units(("net", "us-east-1"));
        var exec = new BlockingExecutor { Blocks = u => u.Collector == Collectors.CoreNetwork.Id };
        var now = new DateTime(2026, 10, 16, 9, 0, 0, DateTimeKind.Utc);
        var engine = new ScanEngine(() => now = now.AddMilliseconds(2)) { HardCap = TimeSpan.FromMilliseconds(100) };

        await engine.RunTickAsync(units, exec, _ => Task.CompletedTask, CancellationToken.None);

        var core = units.First();
        core.Status.Should().Be(UnitStatuses.Pending);
        core.Attempts.Should().Be(1);
        core.Error.Should().Contain("timed out");
    }

    [Fact]
    public async Task A_hanging_first_unit_fails_after_three_ticks()
    {
        var units = Units(("net", "us-east-1"));
        var exec = new BlockingExecutor { Blocks = u => u.Collector == Collectors.CoreNetwork.Id };
        var now = new DateTime(2026, 10, 16, 9, 0, 0, DateTimeKind.Utc);
        var engine = new ScanEngine(() => now = now.AddMilliseconds(2)) { HardCap = TimeSpan.FromMilliseconds(100) };

        for (var i = 0; i < 3; i++) await engine.RunTickAsync(units, exec, _ => Task.CompletedTask, CancellationToken.None);

        var core = units.First();
        core.Status.Should().Be(UnitStatuses.Failed);
        core.Attempts.Should().Be(3);
    }
}
