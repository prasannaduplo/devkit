using Amazon.EC2.Model;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Core.Aws.Normalize;

public sealed record CoreNetworkData(
    List<Vpc> Vpcs, List<Subnet> Subnets, List<RouteTable> RouteTables, List<NetworkAcl> NetworkAcls,
    List<InternetGateway> InternetGateways, List<EgressOnlyInternetGateway> EgressOnlyGateways,
    List<NatGateway> NatGateways, Dictionary<string, List<string>> PrefixLists);

/// <summary>VPCs, subnets (AZ, public/private), route tables with every route (typed target, state, origin,
/// resolved prefix lists), NACLs, IGW / egress-only IGW attachments, NAT gateways and their public IPs.</summary>
public static class CoreNetworkNormalizer
{
    public static readonly string Collector = Collectors.CoreNetwork.Id;

    public static GraphPart Normalize(CollectorContext ctx, CoreNetworkData d)
    {
        var b = ctx.Builder(Collector);

        foreach (var v in d.Vpcs)
        {
            var owner = v.OwnerId ?? ctx.Account;
            var n = b.Node(ctx.NetworkId(v.VpcId), NodeKinds.Network, v.VpcId, owner, ctx.Region)
                .Tagged(Aws.Tags(v.Tags)).Under(ctx.AccountId(owner)).SetState(v.State?.Value)
                .Attr("isDefault", v.IsDefault ?? false);
            n.Cidrs.AddRange(Aws.L(v.CidrBlockAssociationSet)
                .Where(a => a.CidrBlockState?.State?.Value == "associated" && a.CidrBlock != null).Select(a => a.CidrBlock));
            if (n.Cidrs.Count == 0 && v.CidrBlock != null) n.Cidrs.Add(v.CidrBlock);
            n.Cidrs.AddRange(Aws.L(v.Ipv6CidrBlockAssociationSet)
                .Where(a => a.Ipv6CidrBlockState?.State?.Value == "associated").Select(a => a.Ipv6CidrBlock).OfType<string>());
            n.Raw = RawJson.From(v);
        }

        var mainRtByVpc = new Dictionary<string, RouteTable>(StringComparer.Ordinal);
        var rtBySubnet = new Dictionary<string, RouteTable>(StringComparer.Ordinal);
        foreach (var rt in d.RouteTables)
            foreach (var a in Aws.L(rt.Associations))
            {
                if (a.Main == true) mainRtByVpc[rt.VpcId] = rt;
                if (a.SubnetId != null) rtBySubnet[a.SubnetId] = rt;
            }

        foreach (var rt in d.RouteTables)
        {
            var rtId = ctx.Id(NodeKinds.RouteTable, rt.RouteTableId);
            var n = b.Node(rtId, NodeKinds.RouteTable, rt.RouteTableId, rt.OwnerId ?? ctx.Account, ctx.Region)
                .Tagged(Aws.Tags(rt.Tags)).Under(ctx.NetworkId(rt.VpcId))
                .Attr("main", Aws.L(rt.Associations).Any(a => a.Main == true));
            n.Raw = RawJson.From(rt);

            foreach (var route in Aws.L(rt.Routes))
            {
                if (RouteTarget(route) is not { } target) continue;
                var dest = route.DestinationCidrBlock ?? route.DestinationIpv6CidrBlock ?? route.DestinationPrefixListId ?? "";
                var e = b.Edge(rtId, EdgeKinds.RoutesTo, ctx.Id(target.Kind, target.NativeId, target.Kind == NodeKinds.Peering ? "global" : null), dest)
                    .Attr("destination", dest)
                    .Attr("state", route.State?.Value ?? "active")
                    .Attr("origin", route.Origin?.Value);
                if (route.DestinationPrefixListId is { } pl && d.PrefixLists.TryGetValue(pl, out var cidrs))
                    e.Attr("prefixListCidrs", NodeExtensions.Arr(cidrs));
            }

            foreach (var a in Aws.L(rt.Associations))
            {
                if (a.SubnetId != null)
                    b.Edge(ctx.Id(NodeKinds.Subnet, a.SubnetId), EdgeKinds.Associated, rtId);
                else if (a.GatewayId != null)   // edge association (IGW/VGW ingress routing, e.g. GWLB inspection)
                    b.Edge(ctx.Id(AwsIds.KindForPrefix(a.GatewayId), a.GatewayId), EdgeKinds.Associated, rtId).Attr("edgeAssociation", true);
            }
        }

        foreach (var s in d.Subnets)
        {
            var n = b.Node(ctx.Id(NodeKinds.Subnet, s.SubnetId), NodeKinds.Subnet, s.SubnetId, s.OwnerId ?? ctx.Account, ctx.Region)
                .Tagged(Aws.Tags(s.Tags)).Under(ctx.NetworkId(s.VpcId)).SetState(s.State?.Value)
                .Attr("az", s.AvailabilityZone).Attr("azId", s.AvailabilityZoneId);
            if (s.CidrBlock != null) n.Cidrs.Add(s.CidrBlock);
            n.Cidrs.AddRange(Aws.L(s.Ipv6CidrBlockAssociationSet)
                .Where(a => a.Ipv6CidrBlockState?.State?.Value == "associated").Select(a => a.Ipv6CidrBlock).OfType<string>());

            var explicitRt = rtBySubnet.GetValueOrDefault(s.SubnetId);
            var rt = explicitRt ?? mainRtByVpc.GetValueOrDefault(s.VpcId);
            if (explicitRt == null && rt != null)
                b.Edge(n.Id, EdgeKinds.Associated, ctx.Id(NodeKinds.RouteTable, rt.RouteTableId)).Attr("implicit", true);
            n.Attr("isPublic", rt != null && Aws.L(rt.Routes).Any(r =>
                (r.DestinationCidrBlock == "0.0.0.0/0" || r.DestinationIpv6CidrBlock == "::/0")
                && r.GatewayId?.StartsWith("igw-", StringComparison.Ordinal) == true
                && r.State?.Value != "blackhole"));
            n.Raw = RawJson.From(s);
        }

        foreach (var acl in d.NetworkAcls)
        {
            var aclId = ctx.Id(NodeKinds.Nacl, acl.NetworkAclId);
            var n = b.Node(aclId, NodeKinds.Nacl, acl.NetworkAclId, acl.OwnerId ?? ctx.Account, ctx.Region)
                .Tagged(Aws.Tags(acl.Tags)).Under(ctx.NetworkId(acl.VpcId)).Attr("isDefault", acl.IsDefault ?? false);
            n.Raw = RawJson.From(acl);
            foreach (var a in Aws.L(acl.Associations).Where(a => a.SubnetId != null))
                b.Edge(ctx.Id(NodeKinds.Subnet, a.SubnetId), EdgeKinds.Associated, aclId);
        }

        foreach (var igw in d.InternetGateways)
        {
            var attached = Aws.L(igw.Attachments).FirstOrDefault(a => a.VpcId != null);
            var n = b.Node(ctx.Id(NodeKinds.InternetGateway, igw.InternetGatewayId), NodeKinds.InternetGateway, igw.InternetGatewayId, igw.OwnerId ?? ctx.Account, ctx.Region)
                .Tagged(Aws.Tags(igw.Tags)).Under(attached == null ? null : ctx.NetworkId(attached.VpcId));
            n.Raw = RawJson.From(igw);
            foreach (var a in Aws.L(igw.Attachments).Where(a => a.VpcId != null))
                b.Edge(ctx.NetworkId(a.VpcId), EdgeKinds.Attaches, n.Id).Attr("state", a.State?.Value);
        }

        foreach (var eigw in d.EgressOnlyGateways)
        {
            var attached = Aws.L(eigw.Attachments).FirstOrDefault(a => a.VpcId != null);
            var n = b.Node(ctx.Id(NodeKinds.EgressOnlyGateway, eigw.EgressOnlyInternetGatewayId), NodeKinds.EgressOnlyGateway, eigw.EgressOnlyInternetGatewayId, ctx.Account, ctx.Region)
                .Tagged(Aws.Tags(eigw.Tags)).Under(attached == null ? null : ctx.NetworkId(attached.VpcId));
            n.Raw = RawJson.From(eigw);
            foreach (var a in Aws.L(eigw.Attachments).Where(a => a.VpcId != null))
                b.Edge(ctx.NetworkId(a.VpcId), EdgeKinds.Attaches, n.Id);
        }

        foreach (var nat in d.NatGateways)
        {
            var n = b.Node(ctx.Id(NodeKinds.NatGateway, nat.NatGatewayId), NodeKinds.NatGateway, nat.NatGatewayId, ctx.Account, ctx.Region)
                .Tagged(Aws.Tags(nat.Tags)).Under(ctx.Id(NodeKinds.Subnet, nat.SubnetId)).SetState(nat.State?.Value)
                .Attr("connectivityType", nat.ConnectivityType?.Value ?? "public")
                .Attr("privateIps", NodeExtensions.Arr(Aws.L(nat.NatGatewayAddresses).Select(a => a.PrivateIp)));
            n.Raw = RawJson.From(nat);
            foreach (var addr in Aws.L(nat.NatGatewayAddresses).Where(a => a.PublicIp != null))
            {
                var native = addr.AllocationId ?? addr.PublicIp;
                var pip = b.Node(ctx.Id(NodeKinds.PublicIp, native), NodeKinds.PublicIp, native, ctx.Account, ctx.Region)
                    .Named(addr.PublicIp).Under(n.ParentId).Attr("ip", addr.PublicIp).Attr("elastic", addr.AllocationId != null);
                b.Edge(n.Id, EdgeKinds.ExitsVia, pip.Id);
            }
        }

        return b.Build();
    }

    internal static (string Kind, string NativeId)? RouteTarget(Route r)
    {
        if (r.GatewayId is { } g) return g == "local" ? null : (AwsIds.KindForPrefix(g), g);
        if (r.NatGatewayId is { } nat) return (NodeKinds.NatGateway, nat);
        if (r.TransitGatewayId is { } tgw) return (NodeKinds.Hub, tgw);
        if (r.VpcPeeringConnectionId is { } pcx) return (NodeKinds.Peering, pcx);
        if (r.EgressOnlyInternetGatewayId is { } eigw) return (NodeKinds.EgressOnlyGateway, eigw);
        if (r.NetworkInterfaceId is { } eni) return (NodeKinds.NetworkInterface, eni);
        if (r.InstanceId is { } i) return (NodeKinds.Workload, i);
        if (r.LocalGatewayId is { } lgw) return (NodeKinds.OtherGateway, lgw);
        if (r.CarrierGatewayId is { } cagw) return (NodeKinds.OtherGateway, cagw);
        if (r.CoreNetworkArn is { } cn) return (NodeKinds.OtherGateway, cn);
        return null;
    }
}
