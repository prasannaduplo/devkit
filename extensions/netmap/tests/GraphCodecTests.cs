using Duplo.Extension.NetMap.Core.Graph;
using System.Text.Json.Nodes;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class GraphCodecTests
{
    private static NetworkGraph Sample(DateTime collectedAt, params string[] seenFrom)
    {
        var n = new GraphNode { Id = "aws:-:us-east-1:network:vpc-1", Kind = NodeKinds.Network, NativeId = "vpc-1", Name = "egress", CollectedAt = collectedAt };
        n.SeenFrom.AddRange(seenFrom);
        n.Attr("isDefault", false);
        n.Tags["b"] = "2";
        n.Tags["a"] = "1";
        return new NetworkGraph { Nodes = { n }, Edges = { new GraphEdge { Id = "e1", From = n.Id, To = n.Id, Kind = EdgeKinds.Contains } } };
    }

    [Fact]
    public void Round_trips_through_gzip_json_and_compresses()
    {
        var g = Sample(DateTime.UtcNow, "s1");
        var bytes = GraphCodec.Encode(g);
        var back = GraphCodec.Decode<NetworkGraph>(bytes);

        back.Nodes.Single().Name.Should().Be("egress");
        back.Nodes.Single().AttrBool("isDefault").Should().BeFalse();
        back.Edges.Single().Kind.Should().Be(EdgeKinds.Contains);

        var big = new NetworkGraph();
        for (var i = 0; i < 2000; i++) big.Nodes.Add(new GraphNode { Id = $"aws:-:us-east-1:subnet:subnet-{i}", Kind = NodeKinds.Subnet, NativeId = $"subnet-{i}" });
        GraphCodec.Encode(big).Length.Should().BeLessThan(GraphCodec.ToJson(big).Length / 5);
    }

    [Fact]
    public void Hash_ignores_collection_time_seen_from_order_and_tag_order()
    {
        var a = GraphCodec.ContentHash(Sample(new DateTime(2026, 1, 1), "s1", "s2"));
        var b = GraphCodec.ContentHash(Sample(new DateTime(2026, 6, 1), "s2", "s1"));
        a.Should().Be(b);
    }

    [Fact]
    public void Hash_changes_when_content_changes()
    {
        var g1 = Sample(DateTime.UtcNow, "s1");
        var g2 = Sample(DateTime.UtcNow, "s1");
        g2.Nodes[0].Attr("isDefault", true);
        GraphCodec.ContentHash(g1).Should().NotBe(GraphCodec.ContentHash(g2));
    }

    private static NetworkGraph Rich(bool flip)
    {
        var n = new GraphNode { Id = "n1", Kind = NodeKinds.Network, NativeId = "n1" };
        n.Cidrs.AddRange(flip ? new[] { "10.0.0.0/16", "10.1.0.0/16" } : new[] { "10.1.0.0/16", "10.0.0.0/16" });
        n.Raw = flip
            ? new JsonObject { ["a"] = 1, ["z"] = new JsonObject { ["x"] = 1, ["y"] = 2 } }
            : new JsonObject { ["z"] = new JsonObject { ["y"] = 2, ["x"] = 1 }, ["a"] = 1 };
        n.Attrs["o"] = flip ? new JsonObject { ["p"] = 1, ["q"] = 2 } : new JsonObject { ["q"] = 2, ["p"] = 1 };
        var e = new GraphEdge { Id = "e1", From = "n1", To = "n1", Kind = EdgeKinds.Contains };
        if (flip) { e.Attrs["a"] = 1; e.Attrs["b"] = new JsonObject { ["x"] = 1, ["y"] = new JsonArray(new JsonObject { ["m"] = 1, ["n"] = 2 }) }; }
        else { e.Attrs["b"] = new JsonObject { ["x"] = 1, ["y"] = new JsonArray(new JsonObject { ["n"] = 2, ["m"] = 1 }) }; e.Attrs["a"] = 1; }
        var f = new Finding { RuleId = "r", NodeIds = flip ? new() { "a", "b" } : new() { "b", "a" }, EdgeIds = flip ? new() { "x", "y" } : new() { "y", "x" } };
        return new NetworkGraph { Nodes = { n }, Edges = { e }, Findings = { f } };
    }

    [Fact]
    public void Hash_is_independent_of_cidr_key_and_finding_id_order()
        => GraphCodec.ContentHash(Rich(false)).Should().Be(GraphCodec.ContentHash(Rich(true)));

    [Fact]
    public void Hash_does_not_mutate_input_and_still_detects_nested_change()
    {
        var g = Rich(false);
        var before = GraphCodec.ToJson(g);
        var h = GraphCodec.ContentHash(g);
        GraphCodec.ToJson(g).Should().Be(before);
        g.Nodes[0].Raw!["z"]!["x"] = 99;
        GraphCodec.ContentHash(g).Should().NotBe(h);
    }

    private static NetworkGraph WithNode(Action<GraphNode> setup)
    {
        var n = new GraphNode { Id = "aws:-:us-east-1:route-table:rtb-1", Kind = NodeKinds.Network, NativeId = "rtb-1" };
        setup(n);
        return new NetworkGraph { Nodes = { n } };
    }

    [Fact]
    public void Hash_ignores_order_of_arrays_in_raw()
    {
        var a = WithNode(n => n.Raw = JsonNode.Parse("{\"Associations\":[{\"SubnetId\":\"a\"},{\"SubnetId\":\"b\"}]}")!.AsObject());
        var b = WithNode(n => n.Raw = JsonNode.Parse("{\"Associations\":[{\"SubnetId\":\"b\"},{\"SubnetId\":\"a\"}]}")!.AsObject());
        GraphCodec.ContentHash(a).Should().Be(GraphCodec.ContentHash(b));
    }

    [Fact]
    public void Hash_ignores_order_of_scalar_arrays_in_node_and_edge_attrs()
    {
        NetworkGraph G(params string[] ips)
        {
            var g = WithNode(n => n.Attr("privateIps", new JsonArray(ips.Select(i => (JsonNode?)JsonValue.Create(i)).ToArray())));
            g.Edges.Add(new GraphEdge { Id = "e", From = "x", To = "y", Kind = EdgeKinds.Contains, Attrs = { ["ips"] = new JsonArray(ips.Select(i => (JsonNode?)JsonValue.Create(i)).ToArray()) } });
            return g;
        }
        GraphCodec.ContentHash(G("10.0.0.1", "10.0.0.2")).Should().Be(GraphCodec.ContentHash(G("10.0.0.2", "10.0.0.1")));
    }

    [Fact]
    public void Hash_changes_when_an_array_element_changes_and_encoding_keeps_order()
    {
        var a = WithNode(n => n.Raw = JsonNode.Parse("{\"A\":[{\"S\":\"a\"},{\"S\":\"b\"}]}")!.AsObject());
        var b = WithNode(n => n.Raw = JsonNode.Parse("{\"A\":[{\"S\":\"a\"},{\"S\":\"c\"}]}")!.AsObject());
        GraphCodec.ContentHash(a).Should().NotBe(GraphCodec.ContentHash(b));
        var r = WithNode(n => n.Raw = JsonNode.Parse("{\"A\":[\"z\",\"a\"]}")!.AsObject());
        GraphCodec.ToJson(r).Should().Contain("[\"z\",\"a\"]");
    }
}
