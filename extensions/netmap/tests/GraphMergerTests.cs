using Duplo.Extension.NetMap.Core.Graph;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class GraphMergerTests
{
    private const string Tgw = "aws:-:us-east-1:hub:tgw-1";

    [Fact]
    public void Same_node_from_two_scopes_merges_and_the_richer_view_wins()
    {
        var fromSpoke = new GraphNode { Id = Tgw, Kind = NodeKinds.Hub, NativeId = "tgw-1", Name = "tgw-1", Visibility = Visibilities.Partial, SeenFrom = { "spoke" } };
        fromSpoke.Tags["team"] = "net";
        fromSpoke.Attr("asn", 64512);
        var fromOwner = new GraphNode { Id = Tgw, Kind = NodeKinds.Hub, NativeId = "tgw-1", Name = "egress-tgw", Visibility = Visibilities.Full, SeenFrom = { "network" }, ParentId = "aws:-:global:account:111111111111" };
        fromOwner.Tags["Name"] = "egress-tgw";

        var (nodes, _) = GraphMerger.Merge(new[]
        {
            new GraphPart { Nodes = { fromSpoke } },
            new GraphPart { Nodes = { fromOwner } },
        });

        var n = nodes.Single();
        n.Visibility.Should().Be(Visibilities.Full);
        n.Name.Should().Be("egress-tgw");
        n.SeenFrom.Should().BeEquivalentTo("spoke", "network");
        n.Tags.Should().ContainKeys("Name", "team");
        n.AttrInt("asn").Should().Be(64512);
        n.ParentId.Should().Be("aws:-:global:account:111111111111");
    }

    [Fact]
    public void Stub_never_overwrites_a_full_node_and_blueprint_membership_sticks()
    {
        var full = new GraphNode { Id = "n", NativeId = "vpc-1", Name = "prod", Visibility = Visibilities.Full, Cidrs = { "10.0.0.0/16" } };
        var stub = new GraphNode { Id = "n", NativeId = "vpc-1", Name = "vpc-1", Cidrs = { "10.0.0.0/16", "10.1.0.0/16" } }.AsStub();

        var (nodes, _) = GraphMerger.Merge(new[] { new GraphPart { Nodes = { stub } }, new GraphPart { Nodes = { full } } });

        var n = nodes.Single();
        n.Name.Should().Be("prod");
        n.Visibility.Should().Be(Visibilities.Full);
        n.Membership.Should().Be(Memberships.Blueprint);
        n.Cidrs.Should().BeEquivalentTo("10.0.0.0/16", "10.1.0.0/16");
    }

    [Fact]
    public void Stub_name_hint_is_used_when_no_better_name_exists()
    {
        var stub = new GraphNode { Id = "n", NativeId = "vpc-9", Name = "vpc-9" }.AsStub().Attr("nameHint", "shared-services");
        var (nodes, _) = GraphMerger.Merge(new[] { new GraphPart { Nodes = { stub } } });
        nodes.Single().Name.Should().Be("shared-services");
    }

    [Fact]
    public void Duplicate_edges_merge_their_attributes()
    {
        var e1 = new GraphEdge { Id = "e", From = "a", To = "b", Kind = EdgeKinds.Attaches }.Attr("state", "available");
        var e2 = new GraphEdge { Id = "e", From = "a", To = "b", Kind = EdgeKinds.Attaches }.Attr("resourceType", "vpc");

        var (_, edges) = GraphMerger.Merge(new[] { new GraphPart { Edges = { e1 } }, new GraphPart { Edges = { e2 } } });

        edges.Single().Attrs.Keys.Should().BeEquivalentTo("state", "resourceType");
    }
}
