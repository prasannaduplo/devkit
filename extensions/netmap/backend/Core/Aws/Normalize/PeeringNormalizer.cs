using Amazon.EC2.Model;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Core.Aws.Normalize;

public sealed record PeeringData(List<VpcPeeringConnection> Connections);

/// <summary>VPC peerings touching a member VPC. The far side (other account and/or region) becomes a stub
/// carrying its CIDRs -- peering bypasses the TGW, which is itself worth seeing.</summary>
public static class PeeringNormalizer
{
    public static readonly string Collector = Collectors.Peering.Id;

    public static GraphPart Normalize(CollectorContext ctx, PeeringData d)
    {
        var b = ctx.Builder(Collector);
        var members = new HashSet<string>(ctx.MemberVpcIds, StringComparer.Ordinal);

        foreach (var p in d.Connections)
        {
            var req = p.RequesterVpcInfo;
            var acc = p.AccepterVpcInfo;
            var n = b.Node(ctx.Id(NodeKinds.Peering, p.VpcPeeringConnectionId, "global"), NodeKinds.Peering, p.VpcPeeringConnectionId, req?.OwnerId ?? ctx.Account, "global")
                .Tagged(Aws.Tags(p.Tags)).Under(ctx.AccountId(req?.OwnerId)).SetState(p.Status?.Code?.Value)
                .Attr("requesterVpc", req?.VpcId).Attr("requesterAccount", req?.OwnerId).Attr("requesterRegion", req?.Region).Attr("requesterCidr", req?.CidrBlock)
                .Attr("accepterVpc", acc?.VpcId).Attr("accepterAccount", acc?.OwnerId).Attr("accepterRegion", acc?.Region).Attr("accepterCidr", acc?.CidrBlock);
            n.Raw = RawJson.From(p);

            var reqId = Side(b, ctx, members, req);
            var accId = Side(b, ctx, members, acc);
            if (reqId != null) b.Edge(reqId, EdgeKinds.Peers, n.Id);
            if (accId != null) b.Edge(n.Id, EdgeKinds.Peers, accId);
        }

        return b.Build();
    }

    private static string? Side(PartBuilder b, CollectorContext ctx, HashSet<string> members, VpcPeeringConnectionVpcInfo? info)
    {
        if (info?.VpcId == null) return null;
        var region = info.Region ?? ctx.Region;
        var id = ctx.NetworkId(info.VpcId, region);
        if (members.Contains(info.VpcId) && region == ctx.Region) return id;
        if (b.Has(id)) return id;

        var stub = b.Node(id, NodeKinds.Network, info.VpcId, info.OwnerId, region).AsStub().Under(ctx.AccountId(info.OwnerId));
        foreach (var c in Aws.L(info.CidrBlockSet).Select(c => c.Cidr).OfType<string>())
            if (!stub.Cidrs.Contains(c)) stub.Cidrs.Add(c);
        if (stub.Cidrs.Count == 0 && info.CidrBlock != null) stub.Cidrs.Add(info.CidrBlock);
        return id;
    }
}
