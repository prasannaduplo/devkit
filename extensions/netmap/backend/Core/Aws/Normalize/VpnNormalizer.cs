using Amazon.EC2.Model;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Core.Aws.Normalize;

public sealed record VpnData(List<VpnGateway> Gateways, List<VpnConnection> Connections, List<CustomerGateway> CustomerGateways);

/// <summary>Virtual private gateways, site-to-site VPN connections on VGWs AND Transit Gateways (v0 dropped the
/// latter), tunnels with status/message/last change/accepted routes, and customer gateways (IP, BGP ASN, name).
/// Raw documents go through the sanitizer, which strips the pre-shared keys.</summary>
public static class VpnNormalizer
{
    public static readonly string Collector = Collectors.Vpn.Id;

    public static GraphPart Normalize(CollectorContext ctx, VpnData d)
    {
        var b = ctx.Builder(Collector);
        var viaTransit = ctx.PriorNodes(NodeKinds.HubAttachment)
            .Where(a => a.AttrString("resourceType") == "vpn").Select(a => a.AttrString("resourceId")).OfType<string>()
            .ToHashSet(StringComparer.Ordinal);

        foreach (var vgw in d.Gateways)
        {
            var attached = Aws.L(vgw.VpcAttachments).Where(a => a.State?.Value == "attached" && a.VpcId != null).ToList();
            var n = b.Node(ctx.Id(NodeKinds.VpnGateway, vgw.VpnGatewayId), NodeKinds.VpnGateway, vgw.VpnGatewayId, ctx.Account, ctx.Region)
                .Tagged(Aws.Tags(vgw.Tags)).Under(attached.Count > 0 ? ctx.NetworkId(attached[0].VpcId) : ctx.AccountId(null))
                .SetState(vgw.State?.Value).Attr("asn", vgw.AmazonSideAsn).Attr("vpnType", vgw.Type?.Value);
            n.Raw = RawJson.From(vgw);
            foreach (var a in attached) b.Edge(ctx.NetworkId(a.VpcId), EdgeKinds.Attaches, n.Id);
        }

        foreach (var c in d.Connections)
        {
            var tunnels = Aws.L(c.VgwTelemetry);
            var staticOnly = c.Options?.StaticRoutesOnly ?? false;
            var n = b.Node(ctx.Id(NodeKinds.VpnConnection, c.VpnConnectionId), NodeKinds.VpnConnection, c.VpnConnectionId, ctx.Account, ctx.Region)
                .Tagged(Aws.Tags(c.Tags)).Under(ctx.AccountId(null)).SetState(c.State?.Value)
                .Attr("routing", staticOnly ? "static" : "bgp").Attr("category", c.Category).Attr("vpnType", c.Type?.Value)
                .Attr("staticRoutes", NodeExtensions.Arr(Aws.L(c.Routes).Select(r => r.DestinationCidrBlock)))
                .Attr("tunnelsUp", tunnels.Count(t => t.Status?.Value == "UP")).Attr("tunnelsTotal", tunnels.Count)
                .Attr("transitGatewayId", c.TransitGatewayId).Attr("vpnGatewayId", c.VpnGatewayId);
            n.Raw = RawJson.From(c);

            if (c.VpnGatewayId != null)
                b.Edge(n.Id, EdgeKinds.Attaches, ctx.Id(NodeKinds.VpnGateway, c.VpnGatewayId));
            else if (c.TransitGatewayId != null && !viaTransit.Contains(c.VpnConnectionId))
                b.Edge(n.Id, EdgeKinds.Attaches, ctx.Id(NodeKinds.Hub, c.TransitGatewayId));
            if (c.CustomerGatewayId != null)
                b.Edge(n.Id, EdgeKinds.TunnelsTo, ctx.Id(NodeKinds.PeerGateway, c.CustomerGatewayId));

            foreach (var t in tunnels.Where(t => t.OutsideIpAddress != null))
            {
                var native = $"{c.VpnConnectionId}/{t.OutsideIpAddress}";
                b.Node(ctx.Id(NodeKinds.VpnTunnel, native), NodeKinds.VpnTunnel, native, ctx.Account, ctx.Region)
                    .Named(t.OutsideIpAddress).Under(n.Id).SetState(t.Status?.Value)
                    .Attr("outsideIp", t.OutsideIpAddress).Attr("status", t.Status?.Value).Attr("statusMessage", t.StatusMessage)
                    .Attr("lastStatusChange", t.LastStatusChange?.ToUniversalTime().ToString("o")).Attr("acceptedRouteCount", t.AcceptedRouteCount);
            }
        }

        foreach (var cgw in d.CustomerGateways)
        {
            var n = b.Node(ctx.Id(NodeKinds.PeerGateway, cgw.CustomerGatewayId), NodeKinds.PeerGateway, cgw.CustomerGatewayId, ctx.Account, ctx.Region)
                .Named(cgw.DeviceName ?? cgw.IpAddress).Tagged(Aws.Tags(cgw.Tags)).SetState(cgw.State)
                .Attr("ip", cgw.IpAddress).Attr("bgpAsn", cgw.BgpAsn).Attr("deviceName", cgw.DeviceName).Attr("gatewayType", cgw.Type);
            n.Raw = RawJson.From(cgw);
        }

        return b.Build();
    }
}
