using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class EgressAnalyzerTests
{
    private static string Id(string kind, string native) => TestCtx.Id(kind, native);

    /// subnet → route table → 0.0.0.0/0 → target, for each case in one graph.
    private static NetworkGraph Graph()
    {
        var b = new PartBuilder("test", "s", TestCtx.Now);
        void Subnet(string s, string? rt) { b.Node(Id(NodeKinds.Subnet, s), NodeKinds.Subnet, s, null, TestCtx.Region); if (rt != null) b.Edge(Id(NodeKinds.Subnet, s), EdgeKinds.Associated, Id(NodeKinds.RouteTable, rt)); }
        void Rt(string rt, string? targetKind, string? target, string state = "active", string dest = "0.0.0.0/0")
        {
            b.Node(Id(NodeKinds.RouteTable, rt), NodeKinds.RouteTable, rt, null, TestCtx.Region);
            if (target != null) b.Edge(Id(NodeKinds.RouteTable, rt), EdgeKinds.RoutesTo, Id(targetKind!, target), dest).Attr("destination", dest).Attr("state", state);
        }

        Rt("rt-pub", NodeKinds.InternetGateway, "igw-1");
        b.Node(Id(NodeKinds.InternetGateway, "igw-1"), NodeKinds.InternetGateway, "igw-1", null, TestCtx.Region);
        Subnet("pub", "rt-pub");

        Rt("rt-priv", NodeKinds.NatGateway, "nat-1");
        b.Node(Id(NodeKinds.NatGateway, "nat-1"), NodeKinds.NatGateway, "nat-1", null, TestCtx.Region).Under(Id(NodeKinds.Subnet, "pub"));
        Subnet("priv", "rt-priv");

        Rt("rt-nat-broken", NodeKinds.NatGateway, "nat-2");
        b.Node(Id(NodeKinds.NatGateway, "nat-2"), NodeKinds.NatGateway, "nat-2", null, TestCtx.Region).Under(Id(NodeKinds.Subnet, "iso"));
        Subnet("priv-broken", "rt-nat-broken");

        Rt("rt-hub", NodeKinds.Hub, "tgw-full");
        b.Node(Id(NodeKinds.Hub, "tgw-full"), NodeKinds.Hub, "tgw-full", null, TestCtx.Region);
        Subnet("spoke", "rt-hub");

        Rt("rt-hub-partial", NodeKinds.Hub, "tgw-partial");
        b.Node(Id(NodeKinds.Hub, "tgw-partial"), NodeKinds.Hub, "tgw-partial", null, TestCtx.Region).Visibility = Visibilities.Partial;
        Subnet("spoke-partial", "rt-hub-partial");

        Rt("rt-insp", NodeKinds.Endpoint, "vpce-gwlb");
        Subnet("inspected", "rt-insp");

        Rt("rt-bh", NodeKinds.Peering, "pcx-gone", state: "blackhole");
        Subnet("blackholed", "rt-bh");

        Rt("rt-vgw", NodeKinds.VpnGateway, "vgw-1");
        b.Node(Id(NodeKinds.VpnGateway, "vgw-1"), NodeKinds.VpnGateway, "vgw-1", null, TestCtx.Region);
        Subnet("vpn-sub", "rt-vgw");

        Rt("rt-nat-dead", NodeKinds.NatGateway, "nat-dead");
        b.Node(Id(NodeKinds.NatGateway, "nat-dead"), NodeKinds.NatGateway, "nat-dead", null, TestCtx.Region).Under(Id(NodeKinds.Subnet, "pub")).SetState("failed");
        Subnet("dead-nat-sub", "rt-nat-dead");

        Rt("rt-none", null, null);
        Subnet("iso", "rt-none");
        Subnet("no-rt", null);

        var part = b.Build();
        var nodes = part.Nodes.ToDictionary(n => n.Id);
        StubDeriver.AddMissing(nodes, part.Edges);
        return new NetworkGraph { Nodes = nodes.Values.ToList(), Edges = part.Edges };
    }

    [Theory]
    [InlineData("pub", "direct")]
    [InlineData("priv", "via-nat")]
    [InlineData("priv-broken", "nat-no-igw")]
    [InlineData("spoke", "via-hub")]
    [InlineData("spoke-partial", "via-hub-partial")]
    [InlineData("inspected", "via-inspection")]
    [InlineData("blackholed", "blackhole")]
    [InlineData("iso", "isolated")]
    [InlineData("vpn-sub", "via-vpn")]
    [InlineData("dead-nat-sub", "nat-unavailable")]
    [InlineData("no-rt", "isolated")]
    public void Classifies_each_subnets_default_route(string subnet, string expected)
    {
        var index = new GraphIndex(Graph());
        EgressAnalyzer.Annotate(index);
        index.Node(Id(NodeKinds.Subnet, subnet))!.AttrString("egress").Should().Be(expected);
    }

    [Fact]
    public void Nat_unavailable_is_a_problem_and_via_vpn_is_not()
    {
        EgressAnalyzer.Problem.Should().Contain("nat-unavailable");
        EgressAnalyzer.Problem.Should().NotContain("via-vpn");
    }

    [Fact]
    public void Dangling_edge_endpoints_become_stubs_with_parsed_identity()
    {
        var g = Graph();
        var stub = g.Nodes.Single(n => n.Id == Id(NodeKinds.Endpoint, "vpce-gwlb"));
        stub.Visibility.Should().Be(Visibilities.Stub);
        stub.Kind.Should().Be(NodeKinds.Endpoint);
        stub.Region.Should().Be(TestCtx.Region);
        stub.Membership.Should().Be(Memberships.Outside);
    }

    [Fact]
    public void Account_nodes_are_created_for_referenced_accounts_and_named_after_scopes()
    {
        var nodes = new Dictionary<string, GraphNode>
        {
            ["n1"] = new() { Id = "n1", ParentId = NodeId.Account("aws", "111111111111") },
            ["n2"] = new() { Id = "n2", ParentId = NodeId.Account("aws", "333333333333") },
        };
        AccountNodes.Add(nodes, new Dictionary<string, string> { ["scope-net"] = "111111111111" }, new Dictionary<string, string> { ["scope-net"] = "network-hub" }, TestCtx.Now);

        var inScope = nodes[NodeId.Account("aws", "111111111111")];
        inScope.Kind.Should().Be(NodeKinds.Account);
        inScope.Name.Should().Be("network-hub · 111111111111");
        inScope.AttrBool("inScope").Should().BeTrue();
        var outside = nodes[NodeId.Account("aws", "333333333333")];
        outside.Visibility.Should().Be(Visibilities.Partial);
        outside.Membership.Should().Be(Memberships.Outside);
    }
}
