using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class FindingsAndCapabilitiesTests
{
    private static string Id(string kind, string native) => TestCtx.Id(kind, native);

    private static readonly List<BlueprintMember> Members = new()
    {
        new() { ScopeId = "s", Region = TestCtx.Region, NetworkId = "vpc-a" },
        new() { ScopeId = "s", Region = TestCtx.Region, NetworkId = "vpc-b" },
    };

    private static GraphIndex Index()
    {
        var b = new PartBuilder("t", "s", TestCtx.Now);
        b.Node(Id(NodeKinds.Network, "vpc-a"), NodeKinds.Network, "vpc-a", null, TestCtx.Region).Named("a").Cidrs.Add("10.20.0.0/16");
        b.Node(Id(NodeKinds.Network, "vpc-b"), NodeKinds.Network, "vpc-b", null, TestCtx.Region).Named("b").Cidrs.Add("10.20.128.0/17");

        // SG open inbound 22 + default-allow egress, attached to an ENI; and an unattached SG that is open (no finding)
        b.Node(Id(NodeKinds.SecurityGroup, "sg-bastion"), NodeKinds.SecurityGroup, "sg-bastion", null, TestCtx.Region).Named("bastion");
        b.Node(Id(NodeKinds.NetworkInterface, "eni-1"), NodeKinds.NetworkInterface, "eni-1", null, TestCtx.Region);
        b.Edge(Id(NodeKinds.NetworkInterface, "eni-1"), EdgeKinds.Uses, Id(NodeKinds.SecurityGroup, "sg-bastion"));
        b.Edge(NodeId.Internet, EdgeKinds.Allows, Id(NodeKinds.SecurityGroup, "sg-bastion"), "r1").Attr("direction", "ingress").Attr("protocol", "tcp").Attr("fromPort", 22).Attr("toPort", 22);
        b.Edge(Id(NodeKinds.SecurityGroup, "sg-bastion"), EdgeKinds.Allows, NodeId.Internet, "r2").Attr("direction", "egress").Attr("protocol", "all");
        b.Node(Id(NodeKinds.SecurityGroup, "sg-unused"), NodeKinds.SecurityGroup, "sg-unused", null, TestCtx.Region);
        b.Edge(NodeId.Internet, EdgeKinds.Allows, Id(NodeKinds.SecurityGroup, "sg-unused"), "r3").Attr("protocol", "all");

        // VPNs: one healthy, one degraded
        b.Node(Id(NodeKinds.VpnConnection, "vpn-ok"), NodeKinds.VpnConnection, "vpn-ok", null, TestCtx.Region).Attr("tunnelsUp", 2).Attr("tunnelsTotal", 2).Attr("routing", "bgp");
        b.Node(Id(NodeKinds.VpnConnection, "vpn-bad"), NodeKinds.VpnConnection, "vpn-bad", null, TestCtx.Region).Named("Site E #2").Attr("tunnelsUp", 1).Attr("tunnelsTotal", 2).Attr("routing", "static");

        // blackholes: one VPC route, one TGW route table
        b.Node(Id(NodeKinds.RouteTable, "rt-1"), NodeKinds.RouteTable, "rt-1", null, TestCtx.Region).Named("rt-1");
        b.Edge(Id(NodeKinds.RouteTable, "rt-1"), EdgeKinds.RoutesTo, Id(NodeKinds.Peering, "pcx-x"), "10.9.0.0/16").Attr("destination", "10.9.0.0/16").Attr("state", "blackhole");
        b.Node(Id(NodeKinds.HubRouteTable, "tgw-rtb-1"), NodeKinds.HubRouteTable, "tgw-rtb-1", null, TestCtx.Region).Attr("blackholeRoutes", NodeExtensions.Arr(new[] { "10.77.1.0/24" }));

        // hubs: one full, one partial; flow logs on vpc-a only; subnets with egress already annotated
        b.Node(Id(NodeKinds.Hub, "tgw-1"), NodeKinds.Hub, "tgw-1", null, TestCtx.Region);
        b.Node(Id(NodeKinds.Hub, "tgw-2"), NodeKinds.Hub, "tgw-2", null, TestCtx.Region).Visibility = Visibilities.Partial;
        b.Node(Id(NodeKinds.FlowLogConfig, "fl-1"), NodeKinds.FlowLogConfig, "fl-1", null, TestCtx.Region);
        b.Edge(Id(NodeKinds.Network, "vpc-a"), EdgeKinds.Associated, Id(NodeKinds.FlowLogConfig, "fl-1"));
        b.Node(Id(NodeKinds.Subnet, "s1"), NodeKinds.Subnet, "s1", null, TestCtx.Region).Attr("egress", "via-nat");
        b.Node(Id(NodeKinds.Subnet, "s2"), NodeKinds.Subnet, "s2", null, TestCtx.Region).Attr("egress", "via-hub-partial");

        var part = b.Build();
        return new GraphIndex(new NetworkGraph { Nodes = part.Nodes, Edges = part.Edges });
    }

    [Fact]
    public void Findings_cover_open_sgs_degraded_vpn_blackholes_and_cidr_overlap()
    {
        var f = FindingRules.Evaluate(Index(), Members);

        f.Should().ContainSingle(x => x.RuleId == "NET-001" && x.Severity == Severities.Bad)
            .Which.Message.Should().Be("bastion: inbound tcp/22 open to the internet");
        f.Should().ContainSingle(x => x.RuleId == "NET-002" && x.Severity == Severities.Warn);
        f.Should().ContainSingle(x => x.RuleId == "NET-003").Which.Message.Should().Contain("Site E #2").And.Contain("1/2");
        f.Count(x => x.RuleId == "NET-004").Should().Be(2);
        f.Should().ContainSingle(x => x.RuleId == "NET-005").Which.Message.Should().Contain("10.20.0.0/16").And.Contain("10.20.128.0/17");
        f.Should().NotContain(x => x.NodeIds.Contains(Id(NodeKinds.SecurityGroup, "sg-unused")));
    }

    [Fact]
    public void Duplicate_member_networks_are_counted_once()
    {
        var dupes = new List<BlueprintMember>(Members) { new() { ScopeId = "s2", Region = TestCtx.Region, NetworkId = "vpc-a" } };

        FindingRules.Evaluate(Index(), dupes).Should().ContainSingle(x => x.RuleId == "NET-005");
        CapabilityEvaluator.Evaluate(Index(), dupes, new List<WorkUnit>())[CapabilityKeys.FlowLogs].Reason
            .Should().Be("1 of 2 member network(s) have flow logs");
    }

    [Fact]
    public void Capabilities_reflect_graph_state()
    {
        var caps = CapabilityEvaluator.Evaluate(Index(), Members, new List<WorkUnit>());

        caps[CapabilityKeys.Vpn].State.Should().Be(CapabilityStates.Partial);
        caps[CapabilityKeys.Vpn].Reason.Should().Be("2 connection(s) · 3/4 tunnels up · 1 without redundancy");
        caps[CapabilityKeys.Transit].State.Should().Be(CapabilityStates.Partial);
        caps[CapabilityKeys.Egress].State.Should().Be(CapabilityStates.Partial);
        caps[CapabilityKeys.FlowLogs].State.Should().Be(CapabilityStates.Partial);
        caps[CapabilityKeys.FlowLogs].Reason.Should().Be("1 of 2 member network(s) have flow logs");
        caps[CapabilityKeys.DnsQueryLogs].State.Should().Be(CapabilityStates.None);
        caps[CapabilityKeys.Peering].State.Should().Be(CapabilityStates.None);
        caps[CapabilityKeys.Inspection].State.Should().Be(CapabilityStates.None);
    }

    [Fact]
    public void Denied_units_make_their_capabilities_not_readable_with_the_permission()
    {
        var units = new List<WorkUnit>
        {
            new() { Collector = Collectors.Transit.Id, ScopeId = "scope-prod", Region = TestCtx.Region, Status = UnitStatuses.Denied, MissingPermission = "ec2:DescribeTransitGateways" },
        };
        var t = CapabilityEvaluator.Evaluate(Index(), Members, units)[CapabilityKeys.Transit];
        t.State.Should().Be(CapabilityStates.NotReadable);
        t.Reason.Should().Contain("ec2:DescribeTransitGateways").And.Contain("scope-prod");
    }

    [Fact]
    public void Denied_beats_failed_for_the_same_capability()
    {
        var units = new List<WorkUnit>
        {
            new() { Collector = Collectors.Transit.Id, ScopeId = "scope-a", Region = TestCtx.Region, Status = UnitStatuses.Denied, MissingPermission = "ec2:DescribeTransitGateways" },
            new() { Collector = Collectors.Transit.Id, ScopeId = "scope-b", Region = TestCtx.Region, Status = UnitStatuses.Failed, Error = "boom" },
        };
        var t = CapabilityEvaluator.Evaluate(Index(), Members, units)[CapabilityKeys.Transit];
        t.State.Should().Be(CapabilityStates.NotReadable);
        t.Reason.Should().Contain("scope-a").And.Contain("ec2:DescribeTransitGateways");
    }

    [Fact]
    public void Failed_before_denied_still_ends_not_readable()
    {
        var units = new List<WorkUnit>
        {
            new() { Collector = Collectors.Transit.Id, ScopeId = "scope-b", Region = TestCtx.Region, Status = UnitStatuses.Failed, Error = "boom" },
            new() { Collector = Collectors.Transit.Id, ScopeId = "scope-a", Region = TestCtx.Region, Status = UnitStatuses.Denied, MissingPermission = "ec2:X" },
        };
        CapabilityEvaluator.Evaluate(Index(), Members, units)[CapabilityKeys.Transit].State.Should().Be(CapabilityStates.NotReadable);
    }

    [Fact]
    public void Two_denied_units_name_both_scopes_and_failed_units_use_unknown_error_fallback()
    {
        var units = new List<WorkUnit>
        {
            new() { Collector = Collectors.Transit.Id, ScopeId = "scope-a", Region = "us-east-1", Status = UnitStatuses.Denied, MissingPermission = "ec2:DescribeTransitGateways" },
            new() { Collector = Collectors.Transit.Id, ScopeId = "scope-b", Region = "eu-west-1", Status = UnitStatuses.Denied, MissingPermission = "ec2:DescribeTransitGateways" },
        };
        CapabilityEvaluator.Evaluate(Index(), Members, units)[CapabilityKeys.Transit].Reason
            .Should().Be("not readable in scope-a (us-east-1), scope-b (eu-west-1): missing ec2:DescribeTransitGateways");

        var failed = new List<WorkUnit>
        {
            new() { Collector = Collectors.Transit.Id, ScopeId = "scope-a", Region = "us-east-1", Status = UnitStatuses.Failed },
        };
        var t = CapabilityEvaluator.Evaluate(Index(), Members, failed)[CapabilityKeys.Transit];
        t.State.Should().Be(CapabilityStates.Partial);
        t.Reason.Should().Be("collection failed in scope-a (us-east-1): unknown error");
    }

    [Fact]
    public void Vpn_without_tunnel_data_is_not_counted_as_degraded()
    {
        var b = new PartBuilder("t", "s", TestCtx.Now);
        b.Node(Id(NodeKinds.VpnConnection, "vpn-x"), NodeKinds.VpnConnection, "vpn-x", null, TestCtx.Region);
        var part = b.Build();
        var idx = new GraphIndex(new NetworkGraph { Nodes = part.Nodes, Edges = part.Edges });
        var v = CapabilityEvaluator.Evaluate(idx, Members, new List<WorkUnit>())[CapabilityKeys.Vpn];
        v.State.Should().Be(CapabilityStates.Available);
    }

    [Theory]
    [InlineData("10.0.0.0/16", "10.0.255.0/24", true)]
    [InlineData("10.0.0.0/16", "10.1.0.0/16", false)]
    [InlineData("0.0.0.0/0", "192.0.2.0/24", true)]
    [InlineData("2001:db8::/32", "10.0.0.0/8", false)]
    public void Cidr_overlap(string a, string b, bool overlaps) => Cidr.Overlaps(a, b).Should().Be(overlaps);
}
