using Amazon.EC2.Model;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;
using Nfw = Amazon.NetworkFirewall.Model;

namespace Duplo.Extension.NetMap.Core.Aws.Normalize;

public sealed record EndpointsData(List<VpcEndpoint> Endpoints, List<(Nfw.Firewall Firewall, Nfw.FirewallStatus? Status)> Firewalls);

/// <summary>VPC endpoints (interface / gateway / Gateway Load Balancer) and AWS Network Firewalls with their
/// service-managed endpoints -- a future inspection layer shows up here once it exists.</summary>
public static class EndpointsNormalizer
{
    public static readonly string Collector = Collectors.Endpoints.Id;

    public static GraphPart Normalize(CollectorContext ctx, EndpointsData d)
    {
        var b = ctx.Builder(Collector);

        foreach (var ep in d.Endpoints)
        {
            var n = b.Node(ctx.Id(NodeKinds.Endpoint, ep.VpcEndpointId), NodeKinds.Endpoint, ep.VpcEndpointId, ep.OwnerId ?? ctx.Account, ctx.Region)
                .Named(ShortService(ep.ServiceName)).Tagged(Aws.Tags(ep.Tags)).Under(ctx.NetworkId(ep.VpcId)).SetState(ep.State?.Value)
                .Attr("endpointType", ep.VpcEndpointType?.Value).Attr("serviceName", ep.ServiceName).Attr("privateDns", ep.PrivateDnsEnabled ?? false);
            n.Raw = RawJson.From(ep);
            foreach (var s in Aws.L(ep.SubnetIds)) b.Edge(n.Id, EdgeKinds.PlacedIn, ctx.Id(NodeKinds.Subnet, s));
            foreach (var rt in Aws.L(ep.RouteTableIds)) b.Edge(ctx.Id(NodeKinds.RouteTable, rt), EdgeKinds.Associated, n.Id);
            foreach (var g in Aws.L(ep.Groups).Where(g => g.GroupId != null)) b.Edge(n.Id, EdgeKinds.Uses, ctx.Id(NodeKinds.SecurityGroup, g.GroupId));
            foreach (var eni in Aws.L(ep.NetworkInterfaceIds)) b.Edge(n.Id, EdgeKinds.Attaches, ctx.Id(NodeKinds.NetworkInterface, eni));
        }

        foreach (var (fw, status) in d.Firewalls)
        {
            var n = b.Node(ctx.Id(NodeKinds.FirewallService, fw.FirewallArn), NodeKinds.FirewallService, fw.FirewallArn, ctx.Account, ctx.Region)
                .Named(fw.FirewallName).Under(ctx.NetworkId(fw.VpcId)).Attr("policyArn", fw.FirewallPolicyArn)
                .Tagged((fw.Tags ?? new()).Where(t => t.Key != null).Select(t => KeyValuePair.Create(t.Key, t.Value ?? "")));
            n.Raw = RawJson.From(fw);
            foreach (var m in Aws.L(fw.SubnetMappings).Where(m => m.SubnetId != null))
                b.Edge(n.Id, EdgeKinds.PlacedIn, ctx.Id(NodeKinds.Subnet, m.SubnetId));
            foreach (var (az, sync) in status?.SyncStates ?? new())
            {
                if (sync.Attachment?.EndpointId is not { } vpce) continue;
                var ep = b.Node(ctx.Id(NodeKinds.Endpoint, vpce), NodeKinds.Endpoint, vpce, ctx.Account, ctx.Region)
                    .Named($"Network Firewall endpoint ({az})").Under(ctx.NetworkId(fw.VpcId))
                    .Attr("endpointType", "GatewayLoadBalancer").Attr("managedBy", "network-firewall");
                if (sync.Attachment.SubnetId != null) b.Edge(ep.Id, EdgeKinds.PlacedIn, ctx.Id(NodeKinds.Subnet, sync.Attachment.SubnetId));
                b.Edge(n.Id, EdgeKinds.Attaches, ep.Id);
            }
        }

        return b.Build();
    }

    private static string? ShortService(string? serviceName) =>
        string.IsNullOrEmpty(serviceName) ? null : serviceName.Split('.').Last();
}
