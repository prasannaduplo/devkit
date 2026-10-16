using Amazon.EC2.Model;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Core.Aws.Normalize;

public sealed record TgwRouteTableData(
    TransitGatewayRouteTable Table, List<TransitGatewayRouteTableAssociation> Associations,
    List<TransitGatewayRouteTablePropagation> Propagations, List<TransitGatewayRoute> Routes, bool Truncated = false);

/// <param name="ReadableHubs">TGWs whose route tables this scope could read (only the owner account can).</param>
public sealed record TransitData(
    List<TransitGateway> Gateways, List<TransitGatewayAttachment> Attachments,
    List<TransitGatewayPeeringAttachment> PeeringAttachments, List<TgwRouteTableData> RouteTables, HashSet<string> ReadableHubs);

/// <summary>Transit Gateways reached from the member VPCs, ALL their attachments (vpc / vpn / peering / DX /
/// connect -- v0 kept only vpc), route tables with associations, propagations, routes and blackholes. Spoke VPCs
/// outside the blueprint become named stubs; a TGW whose route tables we cannot read is partial.</summary>
public static class TransitNormalizer
{
    public static readonly string Collector = Collectors.Transit.Id;
    private static readonly HashSet<string> GoneStates = new(StringComparer.OrdinalIgnoreCase) { "deleted", "deleting", "failed", "rejected" };

    public static GraphPart Normalize(CollectorContext ctx, TransitData d)
    {
        var b = ctx.Builder(Collector);
        var members = new HashSet<string>(ctx.MemberVpcIds, StringComparer.Ordinal);

        foreach (var tgw in d.Gateways)
        {
            var owner = tgw.OwnerId ?? ctx.Account;
            var n = b.Node(ctx.Id(NodeKinds.Hub, tgw.TransitGatewayId), NodeKinds.Hub, tgw.TransitGatewayId, owner, ctx.Region)
                .Tagged(Aws.Tags(tgw.Tags)).Under(ctx.AccountId(owner)).SetState(tgw.State?.Value)
                .Attr("asn", tgw.Options?.AmazonSideAsn)
                .Attr("defaultAssociationRouteTable", tgw.Options?.AssociationDefaultRouteTableId)
                .Attr("defaultPropagationRouteTable", tgw.Options?.PropagationDefaultRouteTableId);
            n.Visibility = d.ReadableHubs.Contains(tgw.TransitGatewayId) ? Visibilities.Full : Visibilities.Partial;
            n.Raw = RawJson.From(tgw);
        }

        var peeringByAttachment = d.PeeringAttachments.Where(p => p.TransitGatewayAttachmentId != null)
            .ToDictionary(p => p.TransitGatewayAttachmentId, StringComparer.Ordinal);

        var warnings = new List<string>();
        foreach (var a in d.Attachments.Where(a => !GoneStates.Contains(a.State?.Value ?? "")))
        {
            var hubId = ctx.Id(NodeKinds.Hub, a.TransitGatewayId);
            var type = a.ResourceType?.Value ?? "";
            var n = b.Node(ctx.Id(NodeKinds.HubAttachment, a.TransitGatewayAttachmentId), NodeKinds.HubAttachment, a.TransitGatewayAttachmentId, a.TransitGatewayOwnerId ?? ctx.Account, ctx.Region)
                .Tagged(Aws.Tags(a.Tags)).Under(hubId).SetState(a.State?.Value)
                .Attr("resourceType", type).Attr("resourceId", a.ResourceId).Attr("resourceOwner", a.ResourceOwnerId)
                .Attr("associatedRouteTable", a.Association?.TransitGatewayRouteTableId);
            n.Raw = RawJson.From(a);
            b.Edge(n.Id, EdgeKinds.Attaches, hubId);

            switch (type)
            {
                case "vpc":
                    if (a.ResourceId == null) break;
                    var vpcNode = ctx.NetworkId(a.ResourceId);
                    if (!members.Contains(a.ResourceId) && !b.Has(vpcNode))
                    {
                        var stub = b.Node(vpcNode, NodeKinds.Network, a.ResourceId, a.ResourceOwnerId, ctx.Region).AsStub().Under(ctx.AccountId(a.ResourceOwnerId));
                        if (n.Tags.TryGetValue("Name", out var hint) && !string.IsNullOrWhiteSpace(hint)) stub.Attr("nameHint", hint);
                    }
                    b.Edge(vpcNode, EdgeKinds.Attaches, n.Id);
                    break;
                case "vpn":
                    if (a.ResourceId == null) break;
                    b.Edge(ctx.Id(NodeKinds.VpnConnection, a.ResourceId), EdgeKinds.Attaches, n.Id);
                    break;
                case "peering":
                case "tgw-peering":
                    if (peeringByAttachment.TryGetValue(a.TransitGatewayAttachmentId, out var p))
                    {
                        var other = p.RequesterTgwInfo?.TransitGatewayId == a.TransitGatewayId ? p.AccepterTgwInfo : p.RequesterTgwInfo;
                        if (other?.TransitGatewayId != null)
                        {
                            var peerRegion = other.Region ?? ctx.Region;
                            var peerId = ctx.Id(NodeKinds.Hub, other.TransitGatewayId, peerRegion);
                            if (!b.Has(peerId))
                                b.Node(peerId, NodeKinds.Hub, other.TransitGatewayId, other.OwnerId, peerRegion)
                                    .AsStub().Under(ctx.AccountId(other.OwnerId));
                            b.Edge(n.Id, EdgeKinds.Peers, peerId).Attr("peerRegion", other.Region).Attr("peerAccount", other.OwnerId);
                        }
                    }
                    break;
                case "direct-connect-gateway":
                    if (a.ResourceId == null) break;
                    var dx = b.Node(AwsIds.Of("global", NodeKinds.External, a.ResourceId), NodeKinds.External, a.ResourceId, a.ResourceOwnerId, "global")
                        .Named("Direct Connect " + a.ResourceId).Attr("role", "direct-connect");
                    b.Edge(dx.Id, EdgeKinds.Attaches, n.Id);
                    break;
                case "connect":
                    // ResourceId is the transport attachment (transport <- connect).
                    if (a.ResourceId != null) b.Edge(n.Id, EdgeKinds.Attaches, ctx.Id(NodeKinds.HubAttachment, a.ResourceId));
                    break;
                default:
                    if (a.ResourceId != null) b.Edge(ctx.Id(NodeKinds.OtherGateway, a.ResourceId), EdgeKinds.Attaches, n.Id);
                    break;
            }
        }

        foreach (var rtd in d.RouteTables)
        {
            var t = rtd.Table;
            var rtId = ctx.Id(NodeKinds.HubRouteTable, t.TransitGatewayRouteTableId);
            var blackholes = rtd.Routes.Where(r => r.State?.Value == "blackhole").Select(r => r.DestinationCidrBlock ?? r.PrefixListId);
            var n = b.Node(rtId, NodeKinds.HubRouteTable, t.TransitGatewayRouteTableId, ctx.Account, ctx.Region)
                .Tagged(Aws.Tags(t.Tags)).Under(ctx.Id(NodeKinds.Hub, t.TransitGatewayId)).SetState(t.State?.Value)
                .Attr("defaultAssociation", t.DefaultAssociationRouteTable ?? false)
                .Attr("defaultPropagation", t.DefaultPropagationRouteTable ?? false)
                .Attr("blackholeRoutes", NodeExtensions.Arr(blackholes));
            if (rtd.Truncated)
            {
                n.Attr("routesTruncated", true);
                warnings.Add($"routes of {t.TransitGatewayRouteTableId} truncated at the API limit");
            }
            n.Raw = RawJson.From(t);

            foreach (var a in rtd.Associations.Where(x => x.TransitGatewayAttachmentId != null))
                b.Edge(ctx.Id(NodeKinds.HubAttachment, a.TransitGatewayAttachmentId), EdgeKinds.Associated, rtId);
            foreach (var p in rtd.Propagations.Where(x => x.TransitGatewayAttachmentId != null))
                b.Edge(ctx.Id(NodeKinds.HubAttachment, p.TransitGatewayAttachmentId), EdgeKinds.Propagates, rtId);
            foreach (var r in rtd.Routes.Where(r => r.State?.Value != "blackhole"))
            {
                var dest = r.DestinationCidrBlock ?? r.PrefixListId ?? "";
                foreach (var ra in Aws.L(r.TransitGatewayAttachments).Where(x => x.TransitGatewayAttachmentId != null))
                    b.Edge(rtId, EdgeKinds.RoutesTo, ctx.Id(NodeKinds.HubAttachment, ra.TransitGatewayAttachmentId), dest)
                        .Attr("destination", dest).Attr("state", r.State?.Value).Attr("routeType", r.Type?.Value);
            }
        }

        var part = b.Build();
        part.Warnings.AddRange(warnings);
        return part;
    }
}
