using Duplo.Extension.Cloudflare.Cf;
using FluentAssertions;
using Xunit;
using static Duplo.Extension.Cloudflare.Tests.Fixtures;

namespace Duplo.Extension.Cloudflare.Tests;

public class WorkerDiffTests
{
    private static readonly DateTime Now = new(2026, 10, 14, 12, 0, 0, DateTimeKind.Utc);

    private static Dictionary<string, List<CfDeployment>> Fetched(params (string Script, List<CfDeployment> Deps)[] items)
        => items.ToDictionary(i => i.Script, i => i.Deps);

    /// <summary>State after a baseline scan of api-gateway (live dep-3) and agent-runner (live r-1).</summary>
    private static List<WorkerScriptState> BaselineState() => WorkerDiff.Apply(
        null,
        new[] { Script("api-gateway", "2026-10-10T08:00:00Z"), Script("agent-runner", "2026-10-12T09:30:00Z") },
        Fetched(("api-gateway", Result<CfDeploymentList>("deployments-api-gateway.json").Deployments!),
                ("agent-runner", new() { Deployment("r-1", "2026-10-12T09:30:00Z", null, "rv-1") })),
        Now, baseline: true).Scripts;

    [Fact]
    public void Baseline_records_state_without_events()
    {
        var outcome = WorkerDiff.Apply(
            null,
            Result<List<CfScript>>("scripts.json"),
            Fetched(("api-gateway", Result<CfDeploymentList>("deployments-api-gateway.json").Deployments!)),
            Now, baseline: true);

        outcome.Events.Should().BeEmpty();
        outcome.Scripts.Select(s => s.Name).Should().Equal("agent-runner", "api-gateway");
        var api = outcome.Scripts.Single(s => s.Name == "api-gateway");
        api.CurrentDeploymentId.Should().Be("dep-3");
        api.CurrentVersionIds.Should().Equal("v-3");
        api.LastDeployedBy.Should().Be("dev@example.com");
        api.LastDeployMessage.Should().Be("fix routing");
        // agent-runner wasn't fetched: no deployment recorded and ModifiedOn left null so it's fetched next tick.
        var runner = outcome.Scripts.Single(s => s.Name == "agent-runner");
        runner.CurrentDeploymentId.Should().BeNull();
        runner.ModifiedOn.Should().BeNull();
    }

    [Fact]
    public void Unchanged_inventory_needs_no_fetch_and_emits_nothing()
    {
        var prev = BaselineState();
        var current = new[] { Script("api-gateway", "2026-10-10T08:00:00Z"), Script("agent-runner", "2026-10-12T09:30:00Z") };

        WorkerDiff.NeedingDeployments(prev, current, 50).Should().BeEmpty();
        var outcome = WorkerDiff.Apply(prev, current, Fetched(), Now, baseline: false);
        outcome.Events.Should().BeEmpty();
        outcome.Scripts.Should().BeEquivalentTo(prev);
    }

    [Fact]
    public void Redeploy_emits_one_Deployed_event_and_moves_live_state()
    {
        var prev = BaselineState();
        var current = new[] { Script("api-gateway", "2026-10-14T11:00:00Z"), Script("agent-runner", "2026-10-12T09:30:00Z") };
        WorkerDiff.NeedingDeployments(prev, current, 50).Should().Equal("api-gateway");

        var deps = new List<CfDeployment>
        {
            Deployment("dep-4", "2026-10-14T11:00:00Z", "ai-agent@example.com", "v-4"),
            Deployment("dep-3", "2026-10-10T08:00:00Z", "dev@example.com", "v-3"),
        };
        var outcome = WorkerDiff.Apply(prev, current, Fetched(("api-gateway", deps)), Now, baseline: false);

        outcome.Events.Should().ContainSingle();
        var ev = outcome.Events[0];
        ev.Kind.Should().Be(WorkerEventKinds.Deployed);
        ev.Script.Should().Be("api-gateway");
        ev.DeploymentId.Should().Be("dep-4");
        ev.Author.Should().Be("ai-agent@example.com");
        ev.VersionIds.Should().Equal("v-4");
        outcome.Scripts.Single(s => s.Name == "api-gateway").CurrentDeploymentId.Should().Be("dep-4");

        // Re-polling the same state produces no duplicate.
        var again = WorkerDiff.Apply(outcome.Scripts, current, Fetched(("api-gateway", deps)), Now.AddMinutes(5), baseline: false);
        again.Events.Should().BeEmpty();
    }

    [Fact]
    public void Two_deploys_inside_one_window_are_both_reported_oldest_last()
    {
        var prev = BaselineState();
        var current = new[] { Script("api-gateway", "2026-10-14T11:30:00Z"), Script("agent-runner", "2026-10-12T09:30:00Z") };
        var deps = new List<CfDeployment>
        {
            Deployment("dep-5", "2026-10-14T11:30:00Z", null, "v-5"),
            Deployment("dep-4", "2026-10-14T11:00:00Z", null, "v-4"),
            Deployment("dep-3", "2026-10-10T08:00:00Z", null, "v-3"),
        };
        var outcome = WorkerDiff.Apply(prev, current, Fetched(("api-gateway", deps)), Now, baseline: false);
        outcome.Events.Select(e => e.DeploymentId).Should().Equal("dep-5", "dep-4");
    }

    [Fact]
    public void Settings_only_change_updates_modified_on_without_event()
    {
        var prev = BaselineState();
        var current = new[] { Script("api-gateway", "2026-10-14T09:00:00Z"), Script("agent-runner", "2026-10-12T09:30:00Z") };
        var deps = Result<CfDeploymentList>("deployments-api-gateway.json").Deployments!;   // live still dep-3
        var outcome = WorkerDiff.Apply(prev, current, Fetched(("api-gateway", deps)), Now, baseline: false);

        outcome.Events.Should().BeEmpty();
        outcome.Scripts.Single(s => s.Name == "api-gateway").ModifiedOn.Should().Be(DateTime.Parse("2026-10-14T09:00:00Z").ToUniversalTime());
    }

    [Fact]
    public void New_and_deleted_scripts_each_emit_once()
    {
        var prev = BaselineState();
        var current = new[] { Script("api-gateway", "2026-10-10T08:00:00Z"), Script("new-worker", "2026-10-14T11:45:00Z", "2026-10-14T11:45:00Z") };
        WorkerDiff.NeedingDeployments(prev, current, 50).Should().Equal("new-worker");

        var outcome = WorkerDiff.Apply(prev, current,
            Fetched(("new-worker", new() { Deployment("n-1", "2026-10-14T11:45:00Z", "bot@example.com", "nv-1") })),
            Now, baseline: false);

        outcome.Events.Select(e => (e.Kind, e.Script)).Should().BeEquivalentTo(new[]
        {
            (WorkerEventKinds.ScriptDeleted, "agent-runner"),
            (WorkerEventKinds.ScriptAdded, "new-worker"),
        });
        outcome.Events.Single(e => e.Kind == WorkerEventKinds.ScriptAdded).DeploymentId.Should().Be("n-1");
        outcome.Scripts.Select(s => s.Name).Should().Equal("api-gateway", "new-worker");

        var again = WorkerDiff.Apply(outcome.Scripts, current, Fetched(), Now.AddMinutes(5), baseline: false);
        again.Events.Should().BeEmpty();
    }

    [Fact]
    public void Script_added_while_capped_does_not_replay_its_history_later()
    {
        var prev = BaselineState();
        var current = new[] { Script("api-gateway", "2026-10-10T08:00:00Z"), Script("agent-runner", "2026-10-12T09:30:00Z"), Script("late", "2026-10-14T11:00:00Z") };

        // Tick 1: cap 0 → "late" reported as added but not fetched.
        WorkerDiff.NeedingDeployments(prev, current, 0).Should().BeEmpty();
        var t1 = WorkerDiff.Apply(prev, current, Fetched(), Now, baseline: false);
        t1.Events.Should().ContainSingle(e => e.Kind == WorkerEventKinds.ScriptAdded && e.Script == "late");

        // Tick 2: fetched, it has three historic deployments — no Deployed events, just state.
        WorkerDiff.NeedingDeployments(t1.Scripts, current, 50).Should().Equal("late");
        var deps = new List<CfDeployment>
        {
            Deployment("l-3", "2026-10-14T11:00:00Z"), Deployment("l-2", "2026-10-13T11:00:00Z"), Deployment("l-1", "2026-10-12T11:00:00Z"),
        };
        var t2 = WorkerDiff.Apply(t1.Scripts, current, Fetched(("late", deps)), Now.AddMinutes(5), baseline: false);
        t2.Events.Should().BeEmpty();
        t2.Scripts.Single(s => s.Name == "late").CurrentDeploymentId.Should().Be("l-3");
        WorkerDiff.NeedingDeployments(t2.Scripts, current, 50).Should().BeEmpty();
    }

    [Fact]
    public void Changed_script_beyond_the_cap_is_retried_next_tick()
    {
        var prev = BaselineState();
        var current = new[] { Script("api-gateway", "2026-10-14T11:00:00Z"), Script("agent-runner", "2026-10-14T11:10:00Z") };

        var need = WorkerDiff.NeedingDeployments(prev, current, 1);
        need.Should().Equal("api-gateway");   // oldest change first
        var t1 = WorkerDiff.Apply(prev, current, Fetched(("api-gateway", new() { Deployment("dep-4", "2026-10-14T11:00:00Z") })), Now, false);

        WorkerDiff.NeedingDeployments(t1.Scripts, current, 50).Should().Equal("agent-runner");
    }

    [Theory]
    [InlineData(null, new[] { "api-gateway", "agent-runner", "web" })]
    [InlineData("api-*", new[] { "api-gateway" })]
    [InlineData("API-*, web", new[] { "api-gateway", "web" })]
    [InlineData("agent-runne?", new[] { "agent-runner" })]
    public void Filter_matches_globs_case_insensitively(string? glob, string[] expected)
    {
        var scripts = new[] { Script("api-gateway", "2026-10-01"), Script("agent-runner", "2026-10-01"), Script("web", "2026-10-01") };
        WorkerDiff.Filter(scripts, glob).Select(s => s.Id).Should().Equal(expected);
    }

    [Fact]
    public void History_is_newest_first_and_capped()
    {
        var old = Enumerable.Range(0, 5).Select(i => new WorkerEvent { At = Now.AddHours(-i - 1), Script = $"old{i}" }).ToList();
        var fresh = new[] { new WorkerEvent { At = Now, Script = "fresh" } };

        var merged = WorkerDiff.AppendHistory(old, fresh, 3);
        merged.Select(e => e.Script).Should().Equal("fresh", "old0", "old1");
    }

    [Fact]
    public void Counts_accumulate_by_kind()
    {
        var counts = new WorkerEventCounts { Deployed = 2 };
        WorkerDiff.Count(counts, new[]
        {
            new WorkerEvent { Kind = WorkerEventKinds.Deployed },
            new WorkerEvent { Kind = WorkerEventKinds.ScriptAdded },
            new WorkerEvent { Kind = WorkerEventKinds.ScriptDeleted },
        });
        counts.Should().BeEquivalentTo(new WorkerEventCounts { Added = 1, Deleted = 1, Deployed = 3 });
    }
}
