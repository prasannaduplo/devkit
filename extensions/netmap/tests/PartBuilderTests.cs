using Duplo.Extension.NetMap.Core.Graph;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class PartBuilderTests
{
    private static readonly DateTime Now = new(2026, 10, 16, 9, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void Same_node_id_is_returned_once_and_stamped_with_collector_and_scope()
    {
        var b = new PartBuilder("aws.core-network", "scope-a", Now);
        var n1 = b.Node("aws:-:us-east-1:network:vpc-1", NodeKinds.Network, "vpc-1", "111111111111", "us-east-1");
        var n2 = b.Node("aws:-:us-east-1:network:vpc-1", NodeKinds.Network, "vpc-1", "111111111111", "us-east-1");

        n2.Should().BeSameAs(n1);
        var part = b.Build();
        part.Nodes.Should().ContainSingle();
        n1.CollectedBy.Should().Be("aws.core-network");
        n1.CollectedAt.Should().Be(Now);
        n1.SeenFrom.Should().Equal("scope-a");
        n1.Name.Should().Be("vpc-1");
    }

    [Fact]
    public void Edges_dedupe_by_from_kind_to_qualifier()
    {
        var b = new PartBuilder("c", "s", Now);
        b.Edge("a", EdgeKinds.RoutesTo, "b", "0.0.0.0/0");
        b.Edge("a", EdgeKinds.RoutesTo, "b", "0.0.0.0/0");
        b.Edge("a", EdgeKinds.RoutesTo, "b", "10.0.0.0/8");
        b.Build().Edges.Should().HaveCount(2);
    }

    [Fact]
    public void Name_tag_beats_a_fallback_name_and_attrs_skip_nulls()
    {
        var n = new GraphNode { NativeId = "vpc-1", Name = "vpc-1" };
        n.Named("fallback").Tagged(new[] { KeyValuePair.Create("Name", "egress"), KeyValuePair.Create("env", "prod") });
        n.Name.Should().Be("egress");
        n.Tags.Should().ContainKey("env");

        n.Attr("az", "us-east-1a").Attr("missing", (string?)null).Attr("count", 3).Attr("flag", true);
        n.AttrString("az").Should().Be("us-east-1a");
        n.Attrs.Should().NotContainKey("missing");
        n.AttrInt("count").Should().Be(3);
        n.AttrBool("flag").Should().BeTrue();
    }

    [Fact]
    public void Named_does_not_override_an_existing_name()
    {
        var n = new GraphNode { NativeId = "sg-1", Name = "web" };
        n.Named("other");
        n.Name.Should().Be("web");
    }

    [Theory]
    [InlineData("available", "available")]
    [InlineData("attached", "available")]
    [InlineData("UP", "up")]
    [InlineData("DOWN", "down")]
    [InlineData("pending-acceptance", "pending")]
    [InlineData("deleting", "deleted")]
    [InlineData(null, null)]
    public void State_is_normalized_and_native_kept(string? native, string? normalized)
    {
        var n = new GraphNode().SetState(native);
        n.State.Should().Be(normalized);
        n.NativeState.Should().Be(native);
    }

    [Fact]
    public void AttrStrings_reads_arrays()
    {
        var n = new GraphNode().Attr("ips", NodeExtensions.Arr(new[] { "10.0.0.1", null, "10.0.0.2" }));
        n.AttrStrings("ips").Should().Equal("10.0.0.1", "10.0.0.2");
        n.AttrStrings("absent").Should().BeEmpty();
    }
}
