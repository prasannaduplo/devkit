using Duplo.Extension.NetMap.Core.Aws;
using Duplo.Extension.NetMap.Core.Graph;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class IdsTests
{
    [Fact]
    public void Node_id_round_trips_and_keeps_colons_in_native_id()
    {
        var arn = "arn:aws:elasticloadbalancing:us-east-1:111111111111:loadbalancer/net/web/abc";
        var id = NodeId.For("aws", null, "us-east-1", NodeKinds.LoadBalancer, arn);

        id.Should().Be($"aws:-:us-east-1:load-balancer:{arn}");
        var p = NodeId.Parse(id);
        p.Provider.Should().Be("aws");
        p.Account.Should().BeNull();
        p.Region.Should().Be("us-east-1");
        p.Kind.Should().Be(NodeKinds.LoadBalancer);
        p.NativeId.Should().Be(arn);
    }

    [Fact]
    public void Aws_ids_have_no_account_segment_so_shared_resources_merge()
    {
        AwsIds.Of("us-east-1", NodeKinds.Hub, "tgw-1").Should().Be("aws:-:us-east-1:hub:tgw-1");
    }

    [Fact]
    public void Account_and_well_known_ids()
    {
        NodeId.Account("aws", "111111111111").Should().Be("aws:-:global:account:111111111111");
        NodeId.Account("aws", null).Should().Be("aws:-:global:account:unknown");
        NodeId.Internet.Should().Be("net:-:global:external:internet");
        NodeId.Cidr("::/0").Should().Be("net:-:global:cidr-block:::/0");
        NodeId.Parse(NodeId.Cidr("::/0")).NativeId.Should().Be("::/0");
    }

    [Fact]
    public void Edge_id_is_stable_and_sensitive_to_every_part()
    {
        var a = EdgeId.For("x", EdgeKinds.RoutesTo, "y", "0.0.0.0/0");
        a.Should().Be(EdgeId.For("x", EdgeKinds.RoutesTo, "y", "0.0.0.0/0"));
        a.Should().HaveLength(20);
        a.Should().NotBe(EdgeId.For("x", EdgeKinds.RoutesTo, "y", "10.0.0.0/8"));
        a.Should().NotBe(EdgeId.For("y", EdgeKinds.RoutesTo, "x", "0.0.0.0/0"));
    }

    [Theory]
    [InlineData("tgw-attach-0abc", NodeKinds.HubAttachment)]
    [InlineData("tgw-rtb-0abc", NodeKinds.HubRouteTable)]
    [InlineData("tgw-0abc", NodeKinds.Hub)]
    [InlineData("igw-1", NodeKinds.InternetGateway)]
    [InlineData("vgw-1", NodeKinds.VpnGateway)]
    [InlineData("vpce-1", NodeKinds.Endpoint)]
    [InlineData("lgw-1", NodeKinds.OtherGateway)]
    public void Kind_from_aws_id_prefix(string nativeId, string kind) =>
        AwsIds.KindForPrefix(nativeId).Should().Be(kind);

    [Fact]
    public void Registry_knows_core_kinds_and_falls_back_for_unknown()
    {
        KindRegistry.Get(NodeKinds.Network).Level.Should().Be(1);
        KindRegistry.Get(NodeKinds.NatGateway).Level.Should().Be(2);
        KindRegistry.Get(NodeKinds.Subnet).Level.Should().Be(3);
        KindRegistry.Get(NodeKinds.NetworkInterface).Level.Should().Be(4);
        KindRegistry.Get(NodeKinds.FlowLogConfig).Level.Should().Be(0);
        var unknown = KindRegistry.Get("quantum-router");
        unknown.Level.Should().Be(3);
        unknown.Icon.Should().Be("generic");
    }

    [Fact]
    public void Container_kinds_are_flagged_and_the_kinds_fixture_is_written()
    {
        var containers = new[] { NodeKinds.Account, NodeKinds.Network, NodeKinds.Subnet, NodeKinds.Hub, NodeKinds.VpnConnection,
            NodeKinds.K8sCluster, NodeKinds.K8sNamespace, NodeKinds.EcsCluster };
        KindRegistry.All.Where(k => k.Container).Select(k => k.Kind).Should().BeEquivalentTo(containers);
        KindRegistry.Get("quantum-router").Container.Should().BeFalse();

        var path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../fixtures/generated/kinds.json"));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, GraphCodec.ToJson(KindRegistry.All.OrderBy(k => k.Kind, StringComparer.Ordinal).ToList()));
        File.ReadAllText(path).Should().Contain("\"container\":true").And.Contain("\"kind\":\"vpn-connection\"");
    }
}
