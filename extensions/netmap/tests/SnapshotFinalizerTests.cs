using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class SnapshotFinalizerTests
{
    private static readonly List<BlueprintMember> Members = new()
    {
        new() { ScopeId = "scope-net", Region = TestCtx.Region, NetworkId = "vpc-1" },
        new() { ScopeId = "scope-net", Region = TestCtx.Region, NetworkId = "vpc-gone" },
    };

    private static List<WorkUnit> Units(bool denyTransit)
    {
        var units = ScanPlanner.Plan(Members, Collectors.All);
        var core = new PartBuilder(Collectors.CoreNetwork.Id, "scope-net", TestCtx.Now);
        core.Node(TestCtx.Id(NodeKinds.Network, "vpc-1"), NodeKinds.Network, "vpc-1", "111111111111", TestCtx.Region)
            .Named("egress").Under(NodeId.Account("aws", "111111111111")).Cidrs.Add("10.100.0.0/16");
        core.Edge(TestCtx.Id(NodeKinds.RouteTable, "rt-1"), EdgeKinds.RoutesTo, TestCtx.Id(NodeKinds.Hub, "tgw-x"), "0.0.0.0/0");

        foreach (var u in units)
        {
            if (denyTransit && u.Collector == Collectors.Transit.Id)
            {
                u.Status = UnitStatuses.Denied;
                u.MissingPermission = "ec2:DescribeTransitGatewayAttachments";
                continue;
            }
            u.Status = UnitStatuses.Done;
            u.Part = GraphCodec.Encode(u.Collector == Collectors.CoreNetwork.Id ? core.Build() : new GraphPart());
        }
        return units;
    }

    private static FinalizeOutput Run(bool denyTransit, IReadOnlyDictionary<string, string>? accounts = null) =>
        SnapshotFinalizer.Finalize(new FinalizeInput(Members, Units(denyTransit),
            accounts ?? new Dictionary<string, string> { ["scope-net"] = "111111111111" },
            new Dictionary<string, string> { ["scope-net"] = "network-hub" }, TestCtx.Now));

    [Fact]
    public void Produces_graph_with_stubs_and_accounts_plus_summary_and_member_statuses()
    {
        var o = Run(denyTransit: false);

        o.ScanStatus.Should().Be(ScanStatuses.Complete);
        var tgwId = TestCtx.Id(NodeKinds.Hub, "tgw-x");
        o.Graph.Nodes.Should().Contain(n => n.Id == tgwId && n.Visibility == Visibilities.Stub);
        o.Graph.Nodes.Should().Contain(n => n.Kind == NodeKinds.Account && n.Name == "network-hub · 111111111111");
        o.Summary.NodeCount.Should().Be(o.Graph.Nodes.Count(n => n.Visibility != Visibilities.Stub));
        o.Summary.StubCount.Should().BeGreaterThan(0);
        o.Summary.Capabilities.Keys.Should().Contain(new[] { CapabilityKeys.Egress, CapabilityKeys.Vpn, CapabilityKeys.FlowLogs });
        o.Summary.UnitsDone.Should().Be(o.Summary.UnitsTotal);

        o.MemberStatuses.Single(m => m.NetworkId == "vpc-1").Should().BeEquivalentTo(new { Status = MemberStates.Ok, DisplayName = "egress" });
        o.MemberStatuses.Single(m => m.NetworkId == "vpc-gone").Status.Should().Be(MemberStates.Missing);
    }

    [Fact]
    public void Denied_unit_makes_the_scan_partial_and_is_listed()
    {
        var o = Run(denyTransit: true);
        o.ScanStatus.Should().Be(ScanStatuses.Partial);
        o.Summary.UnitsDenied.Should().Be(1);
        o.Summary.UnitProblems.Single().Should().Contain("aws.transit").And.Contain("ec2:DescribeTransitGatewayAttachments");
        o.Summary.Capabilities[CapabilityKeys.Transit].State.Should().Be(CapabilityStates.NotReadable);
    }

    [Fact]
    public void Hash_is_stable_across_runs_and_core_failure_marks_scope_error()
    {
        Run(false).ContentHash.Should().Be(Run(false).ContentHash);

        var units = Units(false);
        var core = units.Single(u => u.Collector == Collectors.CoreNetwork.Id);
        core.Status = UnitStatuses.Failed; core.Part = null; core.Error = "credentials rejected";
        var o = SnapshotFinalizer.Finalize(new FinalizeInput(Members, units, new Dictionary<string, string>(), new Dictionary<string, string>(), TestCtx.Now));
        o.MemberStatuses.Should().OnlyContain(m => m.Status == MemberStates.ScopeError && m.Message == "credentials rejected");
    }

    [Fact]
    public void Account_ids_fall_back_to_collected_vpc_owners()
    {
        var filled = ScanAccounts.Fill(new Dictionary<string, string>(), Units(false));
        filled["scope-net"].Should().Be("111111111111");
    }

    [Fact]
    public void Denied_core_unit_message_names_the_missing_permission()
    {
        var units = Units(false);
        var core = units.Single(u => u.Collector == Collectors.CoreNetwork.Id);
        core.Status = UnitStatuses.Denied; core.Error = null; core.MissingPermission = "ec2:DescribeVpcs"; core.Part = null;
        var o = SnapshotFinalizer.Finalize(new FinalizeInput(Members, units,
            new Dictionary<string, string> { ["scope-net"] = "111111111111" },
            new Dictionary<string, string> { ["scope-net"] = "network-hub" }, TestCtx.Now));
        o.MemberStatuses.Should().OnlyContain(m => m.Status == MemberStates.ScopeError && m.Message == "denied — missing ec2:DescribeVpcs");
    }

    [Fact]
    public void Part_warnings_are_reported_without_making_the_scan_partial()
    {
        var units = Units(denyTransit: false);
        var w = new GraphPart();
        w.Warnings.Add("network firewall: ec2:Foo");
        units.First(u => u.Collector == Collectors.Vpn.Id).Part = GraphCodec.Encode(w);
        var o = SnapshotFinalizer.Finalize(new FinalizeInput(Members, units,
            new Dictionary<string, string> { ["scope-net"] = "111111111111" },
            new Dictionary<string, string> { ["scope-net"] = "network-hub" }, TestCtx.Now));
        o.ScanStatus.Should().Be(ScanStatuses.Complete);
        o.Summary.UnitProblems.Should().Contain("warning: network firewall: ec2:Foo");
    }

    [Fact]
    public void Parent_ids_pointing_outside_the_graph_are_cleared()
    {
        var units = Units(denyTransit: false);
        var extra = new PartBuilder(Collectors.CoreNetwork.Id, "scope-net", TestCtx.Now);
        extra.Node(TestCtx.Id(NodeKinds.RouteTable, "rt-orphan"), NodeKinds.RouteTable, "rt-orphan", "111111111111", TestCtx.Region)
            .Under(TestCtx.Id(NodeKinds.Network, "vpc-not-collected"));
        var u = units.First(x => x.Collector != Collectors.CoreNetwork.Id);
        u.Part = GraphCodec.Encode(extra.Build());

        var o = SnapshotFinalizer.Finalize(new FinalizeInput(Members, units,
            new Dictionary<string, string> { ["scope-net"] = "111111111111" }, new Dictionary<string, string> { ["scope-net"] = "network-hub" }, TestCtx.Now));

        var ids = o.Graph.Nodes.Select(n => n.Id).ToHashSet();
        o.Graph.Nodes.Single(n => n.Id == TestCtx.Id(NodeKinds.RouteTable, "rt-orphan")).ParentId.Should().BeNull();
        o.Graph.Nodes.Where(n => n.ParentId != null).Should().OnlyContain(n => ids.Contains(n.ParentId!));
        o.Graph.Nodes.Single(n => n.Id == TestCtx.Id(NodeKinds.Network, "vpc-1")).ParentId.Should().Be(NodeId.Account("aws", "111111111111"));
    }
}
