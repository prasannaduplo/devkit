using System.Text.Json.Nodes;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class GraphTransferTests
{
    private const string NaclId = "aws:111111111111:us-east-1:nacl:acl-1";

    // The synthetic hub has no network ACL, so add one with entries the path engine would read.
    private static NetworkGraph Graph()
    {
        var g = SnapshotFinalizer.Finalize(new FinalizeInput(
            SyntheticHub.Members, SyntheticHub.BuildUnits(), SyntheticHub.Accounts, SyntheticHub.ScopeNames, TestCtx.Now)).Graph;
        g.Nodes.Add(new GraphNode
        {
            Id = NaclId, Kind = NodeKinds.Nacl, NativeId = "acl-1", Name = "acl-1",
            Raw = new JsonObject { ["Entries"] = new JsonArray(new JsonObject { ["RuleNumber"] = 100, ["RuleAction"] = "allow" }) },
        });
        return g;
    }

    // Each call re-decodes, as the service does, so FilterRaw's in-place mutation never leaks between cases.
    private static NetworkGraph Fresh() => GraphCodec.Decode<NetworkGraph>(GraphCodec.Encode(Graph()));

    [Fact]
    public void Raw_all_keeps_everything()
    {
        var before = GraphCodec.ToJson(Fresh());
        GraphCodec.ToJson(GraphTransfer.FilterRaw(Fresh(), GraphTransfer.RawAll)).Should().Be(before);
    }

    [Fact]
    public void Raw_routing_keeps_raw_only_for_nacls_and_security_groups()
    {
        var full = Fresh();
        full.Nodes.Count(n => n.Raw != null && !GraphTransfer.RoutingRawKinds.Contains(n.Kind)).Should().BeGreaterThan(10);
        full.Nodes.Should().Contain(n => n.Kind == NodeKinds.SecurityGroup && n.Raw != null);

        var g = GraphTransfer.FilterRaw(Fresh(), GraphTransfer.RawRouting);

        g.Nodes.Where(n => !GraphTransfer.RoutingRawKinds.Contains(n.Kind)).Should().OnlyContain(n => n.Raw == null);
        g.Nodes.Where(n => n.Kind == NodeKinds.SecurityGroup).Should().OnlyContain(n => n.Raw != null);
        g.Nodes.Single(n => n.Id == NaclId).Raw!["Entries"]!.AsArray().Should().HaveCount(1);
        g.Nodes.Should().HaveCount(full.Nodes.Count);
        g.Edges.Should().HaveCount(full.Edges.Count);
        GraphCodec.ToJson(g).Should().NotContain("\"raw\":null");   // nulls stay omitted
    }

    [Fact]
    public void Raw_none_drops_all_raw()
    {
        GraphTransfer.FilterRaw(Fresh(), GraphTransfer.RawNone).Nodes.Should().OnlyContain(n => n.Raw == null);
    }

    [Theory]
    [InlineData(null, "all")]
    [InlineData("", "all")]
    [InlineData("Routing", "routing")]
    [InlineData("none", "none")]
    public void Parses_raw_mode(string? input, string expected) => GraphTransfer.ParseRawMode(input).Should().Be(expected);

    [Fact]
    public void Rejects_unknown_query_values()
    {
        FluentActions.Invoking(() => GraphTransfer.ParseRawMode("some")).Should().Throw<ArgumentException>();
        FluentActions.Invoking(() => GraphTransfer.ParseEncoding("br")).Should().Throw<ArgumentException>();
        GraphTransfer.ParseEncoding(null).Should().Be(GraphTransfer.EncodingJson);
        GraphTransfer.ParseEncoding("GZIP64").Should().Be(GraphTransfer.EncodingGzip64);
    }

    [Theory]
    [InlineData("all")]
    [InlineData("routing")]
    public void Gzip64_round_trips_to_the_exact_json_form(string rawMode)
    {
        var json = GraphTransfer.Body(Fresh(), rawMode, GraphTransfer.EncodingJson);
        var zipped = GraphTransfer.Body(Fresh(), rawMode, GraphTransfer.EncodingGzip64).AsObject();

        zipped["encoding"]!.GetValue<string>().Should().Be("gzip-base64");
        var text = GraphTransfer.Gunzip64(zipped["data"]!.GetValue<string>());
        text.Should().Be(GraphTransfer.ToJson(GraphTransfer.FilterRaw(Fresh(), rawMode)));
        JsonNode.DeepEquals(JsonNode.Parse(text), json).Should().BeTrue();
        zipped["data"]!.GetValue<string>().Length.Should().BeLessThan(text.Length / 3);
    }

    [Fact]
    public void Node_raw_returns_the_one_node()
    {
        var g = Fresh();
        var sg = g.Nodes.First(n => n.Kind == NodeKinds.SecurityGroup);

        var body = GraphTransfer.NodeRaw(g, sg.Id)!;

        body["nodeId"]!.GetValue<string>().Should().Be(sg.Id);
        JsonNode.DeepEquals(body["raw"], sg.Raw).Should().BeTrue();
    }

    [Fact]
    public void Node_raw_for_a_node_without_raw_is_null_raw()
    {
        var g = Fresh();
        var noRaw = g.Nodes.First(n => n.Raw == null);
        var body = GraphTransfer.NodeRaw(g, noRaw.Id)!;
        body["nodeId"]!.GetValue<string>().Should().Be(noRaw.Id);
        body["raw"].Should().BeNull();
    }

    [Fact]
    public void Node_raw_not_found_is_null()
    {
        GraphTransfer.NodeRaw(Fresh(), "aws:-:us-east-1:subnet:subnet-missing").Should().BeNull();
    }
}
