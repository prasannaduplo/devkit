using Amazon.EC2;
using Amazon.EC2.Model;
using Duplo.Extension.NetMap.Core.Aws.Normalize;
using Duplo.Extension.NetMap.Core.Graph;
using FluentAssertions;
using Xunit;

namespace Duplo.Extension.NetMap.Tests;

public class VpnNormalizerTests
{
    private static VpnConnection Conn(string id, string? vgw, string? tgw, string up1, string up2, bool staticOnly = false) => new()
    {
        VpnConnectionId = id, VpnGatewayId = vgw, TransitGatewayId = tgw, CustomerGatewayId = "cgw-1", State = VpnState.Available,
        Tags = new() { new Tag("Name", id == "vpn-tgw" ? "Site E #2" : "Site A prod") },
        CustomerGatewayConfiguration = "<pre_shared_key>TOPSECRET</pre_shared_key>",
        Options = new VpnConnectionOptions { StaticRoutesOnly = staticOnly, TunnelOptions = new() { new TunnelOption { OutsideIpAddress = "203.0.113.1", PreSharedKey = "TOPSECRET2" } } },
        Routes = staticOnly ? new() { new VpnStaticRoute { DestinationCidrBlock = "172.16.50.0/24" } } : null,
        VgwTelemetry = new()
        {
            new VgwTelemetry { OutsideIpAddress = "203.0.113.1", Status = new TelemetryStatus(up1), AcceptedRouteCount = 3 },
            new VgwTelemetry { OutsideIpAddress = "203.0.113.2", Status = new TelemetryStatus(up2), StatusMessage = "IPSEC IS DOWN" },
        },
    };

    private static GraphPart HubAttachmentPrior()
    {
        var b = new PartBuilder("aws.transit", "scope-net", TestCtx.Now);
        b.Node(TestCtx.Id(NodeKinds.HubAttachment, "tgw-attach-vpn"), NodeKinds.HubAttachment, "tgw-attach-vpn", null, TestCtx.Region)
            .Attr("resourceType", "vpn").Attr("resourceId", "vpn-tgw");
        return b.Build();
    }

    private static VpnData Data() => new(
        Gateways: new() { new VpnGateway { VpnGatewayId = "vgw-1", State = VpnState.Available, AmazonSideAsn = 64512,
            VpcAttachments = new() { new VpcAttachment { VpcId = "vpc-1", State = AttachmentStatus.Attached } } } },
        Connections: new() { Conn("vpn-vgw", "vgw-1", null, "UP", "UP"), Conn("vpn-tgw", null, "tgw-1", "UP", "DOWN", staticOnly: true) },
        CustomerGateways: new() { new CustomerGateway { CustomerGatewayId = "cgw-1", IpAddress = "198.51.100.7", BgpAsn = "65010", DeviceName = "site-a-fw", State = "available" } });

    [Fact]
    public void Connections_carry_routing_tunnel_counts_and_never_secrets()
    {
        var p = VpnNormalizer.Normalize(TestCtx.Make(priors: new[] { HubAttachmentPrior() }), Data());
        var bgp = p.Node(NodeKinds.VpnConnection, "vpn-vgw");
        bgp.Name.Should().Be("Site A prod");
        bgp.AttrString("routing").Should().Be("bgp");
        bgp.AttrInt("tunnelsUp").Should().Be(2);

        var stat = p.Node(NodeKinds.VpnConnection, "vpn-tgw");
        stat.AttrString("routing").Should().Be("static");
        stat.AttrStrings("staticRoutes").Should().Equal("172.16.50.0/24");
        stat.AttrInt("tunnelsUp").Should().Be(1);
        stat.AttrInt("tunnelsTotal").Should().Be(2);

        GraphCodec.ToJson(p).Should().NotContain("TOPSECRET");
    }

    [Fact]
    public void Tunnels_are_children_with_status_and_message()
    {
        var p = VpnNormalizer.Normalize(TestCtx.Make(), Data());
        var down = p.Node(NodeKinds.VpnTunnel, "vpn-tgw/203.0.113.2");
        down.ParentId.Should().Be(TestCtx.Id(NodeKinds.VpnConnection, "vpn-tgw"));
        down.State.Should().Be("down");
        down.AttrString("statusMessage").Should().Be("IPSEC IS DOWN");
        p.Node(NodeKinds.VpnTunnel, "vpn-vgw/203.0.113.1").AttrInt("acceptedRouteCount").Should().Be(3);
    }

    [Fact]
    public void Vgw_and_customer_gateway_are_wired_and_tgw_link_comes_from_transit()
    {
        var p = VpnNormalizer.Normalize(TestCtx.Make(priors: new[] { HubAttachmentPrior() }), Data());
        var vpc1 = TestCtx.Id(NodeKinds.Network, "vpc-1");
        var vgw1 = TestCtx.Id(NodeKinds.VpnGateway, "vgw-1");
        p.Edges.Should().Contain(e => e.Kind == EdgeKinds.Attaches && e.From == vpc1 && e.To == vgw1);
        p.EdgesFrom(TestCtx.Id(NodeKinds.VpnConnection, "vpn-vgw"), EdgeKinds.Attaches).Single().To.Should().Be(TestCtx.Id(NodeKinds.VpnGateway, "vgw-1"));
        p.EdgesFrom(TestCtx.Id(NodeKinds.VpnConnection, "vpn-tgw"), EdgeKinds.Attaches).Should().BeEmpty();   // via tgw-attach-vpn
        p.EdgesFrom(TestCtx.Id(NodeKinds.VpnConnection, "vpn-tgw"), EdgeKinds.TunnelsTo).Single().To.Should().Be(TestCtx.Id(NodeKinds.PeerGateway, "cgw-1"));

        var cgw = p.Node(NodeKinds.PeerGateway, "cgw-1");
        cgw.Name.Should().Be("site-a-fw");
        cgw.AttrString("ip").Should().Be("198.51.100.7");
        cgw.AttrString("bgpAsn").Should().Be("65010");
    }

    [Fact]
    public void Tgw_vpn_without_a_transit_attachment_links_straight_to_the_hub()
    {
        var p = VpnNormalizer.Normalize(TestCtx.Make(), Data());
        p.EdgesFrom(TestCtx.Id(NodeKinds.VpnConnection, "vpn-tgw"), EdgeKinds.Attaches).Single().To.Should().Be(TestCtx.Id(NodeKinds.Hub, "tgw-1"));
    }
}
