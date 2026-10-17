using System.Text.Json.Nodes;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;
using Elb = Amazon.ElasticLoadBalancing.Model;
using V2 = Amazon.ElasticLoadBalancingV2.Model;

namespace Duplo.Extension.NetMap.Core.Aws.Normalize;

public sealed record LoadBalancerData(
    List<V2.LoadBalancer> LoadBalancers, List<V2.Listener> Listeners, List<V2.TargetGroup> TargetGroups,
    Dictionary<string, List<V2.TargetHealthDescription>> TargetHealth, Dictionary<string, List<V2.Tag>> Tags,
    List<Elb.LoadBalancerDescription> Classic);

/// <summary>ALB/NLB/GWLB and classic ELBs: scheme, DNS name, listeners, subnet placement, security groups, the
/// LB's own ENIs (matched by AWS's "ELB &lt;type&gt;/&lt;name&gt;/&lt;id&gt;" ENI description, needs the interfaces part), and
/// targets resolved to workloads or ENIs.</summary>
public static class LoadBalancerNormalizer
{
    public static readonly string Collector = Collectors.LoadBalancers.Id;

    public static GraphPart Normalize(CollectorContext ctx, LoadBalancerData d)
    {
        var b = ctx.Builder(Collector);
        var enis = ctx.PriorNodes(NodeKinds.NetworkInterface).ToList();
        var enisByDescription = enis.Where(e => e.AttrString("description") != null)
            .GroupBy(e => e.AttrString("description")!, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);
        var eniByIp = new Dictionary<string, string>(StringComparer.Ordinal);
        var eniByVpcIp = new Dictionary<(string, string), string>();
        foreach (var e in enis)
            foreach (var ip in e.AttrStrings("privateIps"))
            {
                eniByIp.TryAdd(ip, e.Id);
                if (e.AttrString("vpcId") is { } vpc) eniByVpcIp.TryAdd((vpc, ip), e.Id);
            }

        foreach (var lb in d.LoadBalancers)
        {
            var n = b.Node(ctx.Id(NodeKinds.LoadBalancer, lb.LoadBalancerArn), NodeKinds.LoadBalancer, lb.LoadBalancerArn, ctx.Account, ctx.Region)
                .Named(lb.LoadBalancerName).Tagged(Tags(d.Tags.GetValueOrDefault(lb.LoadBalancerArn))).Under(ctx.NetworkId(lb.VpcId))
                .SetState(lb.State?.Code?.Value).Attr("lbType", lb.Type?.Value).Attr("scheme", lb.Scheme?.Value).Attr("dnsName", lb.DNSName)
                .Attr("listeners", Listeners(d.Listeners.Where(l => l.LoadBalancerArn == lb.LoadBalancerArn).Select(l => (l.Port, l.Protocol?.Value))));
            n.Raw = RawJson.From(lb);
            // workload collectors (ECS services) match their target groups to this load balancer
            n.Attr("targetGroupArns", NodeExtensions.Arr(d.TargetGroups.Where(t => Aws.L(t.LoadBalancerArns).Contains(lb.LoadBalancerArn)).Select(t => t.TargetGroupArn)));

            foreach (var az in Aws.L(lb.AvailabilityZones).Where(a => a.SubnetId != null))
                b.Edge(n.Id, EdgeKinds.PlacedIn, ctx.Id(NodeKinds.Subnet, az.SubnetId)).Attr("az", az.ZoneName);
            foreach (var sg in Aws.L(lb.SecurityGroups))
                b.Edge(n.Id, EdgeKinds.Uses, ctx.Id(NodeKinds.SecurityGroup, sg));

            const string marker = "loadbalancer/";
            var idx = lb.LoadBalancerArn.IndexOf(marker, StringComparison.Ordinal);
            if (idx >= 0 && enisByDescription.TryGetValue("ELB " + lb.LoadBalancerArn[(idx + marker.Length)..], out var own))
                foreach (var eni in own) b.Edge(n.Id, EdgeKinds.Attaches, eni.Id);

            foreach (var tg in d.TargetGroups.Where(t => Aws.L(t.LoadBalancerArns).Contains(lb.LoadBalancerArn)))
                foreach (var th in d.TargetHealth.GetValueOrDefault(tg.TargetGroupArn) ?? new())
                {
                    if (th.Target?.Id is not { } tid) continue;
                    var isIp = !(tid.StartsWith("i-", StringComparison.Ordinal) || tid.StartsWith("arn:", StringComparison.Ordinal));
                    var to = !isIp
                        ? ctx.Id(NodeKinds.Workload, tid)
                        : lb.VpcId != null && eniByVpcIp.TryGetValue((lb.VpcId, tid), out var vpcEniId) ? vpcEniId
                        : eniByIp.TryGetValue(tid, out var eniId) ? eniId
                        : InterfacesNormalizer.EnsureCidr(b, tid + (tid.Contains(':') ? "/128" : "/32"));
                    b.Edge(n.Id, EdgeKinds.Targets, to, $"{tg.TargetGroupArn}|{tid}|{th.Target.Port}")
                        .Attr("targetGroup", tg.TargetGroupName).Attr("port", th.Target.Port ?? tg.Port)
                        .Attr("protocol", tg.Protocol?.Value).Attr("health", th.TargetHealth?.State?.Value)
                        // ip-mode target: workload collectors resolve it to the pod / task holding this address
                        .Attr("targetIp", isIp ? tid : null);
                }
        }

        foreach (var c in d.Classic)
        {
            var native = "classic/" + c.LoadBalancerName;
            var n = b.Node(ctx.Id(NodeKinds.LoadBalancer, native), NodeKinds.LoadBalancer, native, ctx.Account, ctx.Region)
                .Named(c.LoadBalancerName).Under(ctx.NetworkId(c.VPCId)).Attr("lbType", "classic").Attr("scheme", c.Scheme).Attr("dnsName", c.DNSName)
                .Attr("listeners", Listeners(Aws.L(c.ListenerDescriptions).Select(l => ((int?)l.Listener?.LoadBalancerPort, l.Listener?.Protocol))));
            n.Raw = RawJson.From(c);
            foreach (var s in Aws.L(c.Subnets)) b.Edge(n.Id, EdgeKinds.PlacedIn, ctx.Id(NodeKinds.Subnet, s));
            foreach (var sg in Aws.L(c.SecurityGroups)) b.Edge(n.Id, EdgeKinds.Uses, ctx.Id(NodeKinds.SecurityGroup, sg));
            foreach (var i in Aws.L(c.Instances).Where(i => i.InstanceId != null)) b.Edge(n.Id, EdgeKinds.Targets, ctx.Id(NodeKinds.Workload, i.InstanceId));
            if (enisByDescription.TryGetValue("ELB " + c.LoadBalancerName, out var own))
                foreach (var eni in own) b.Edge(n.Id, EdgeKinds.Attaches, eni.Id);
        }

        return b.Build();
    }

    private static IEnumerable<KeyValuePair<string, string>> Tags(List<V2.Tag>? tags) =>
        (tags ?? new()).Where(t => !string.IsNullOrEmpty(t.Key)).Select(t => KeyValuePair.Create(t.Key, t.Value ?? ""));

    private static JsonArray Listeners(IEnumerable<(int? Port, string? Protocol)> listeners) =>
        new(listeners.Select(l => (JsonNode?)new JsonObject { ["port"] = l.Port, ["protocol"] = l.Protocol }).ToArray());
}
