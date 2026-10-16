using Amazon.Route53;
using Amazon.Route53.Model;
using Amazon.Route53Resolver.Model;
using Duplo.Extension.NetMap.Core.Aws.Normalize;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;
using ElbModel = Amazon.ElasticLoadBalancing.Model;
using V2 = Amazon.ElasticLoadBalancingV2.Model;

namespace Duplo.Extension.NetMap.Core.Aws.Fetch;

public sealed class LoadBalancersCollector : ICollector
{
    public CollectorDescriptor Descriptor => Collectors.LoadBalancers;

    public async Task<GraphPart> CollectAsync(CollectorContext ctx, IAwsClients aws, CancellationToken ct)
    {
        if (ctx.MemberVpcIds.Count == 0) return new GraphPart();
        var warnings = new List<string>();
        var vpcs = ctx.MemberVpcIds.ToHashSet(StringComparer.Ordinal);
        var v2 = await aws.Elbv2(ct);
        var lbs = (await Aws.All(v2.Paginators.DescribeLoadBalancers(new V2.DescribeLoadBalancersRequest()).LoadBalancers, ct))
            .Where(l => l.VpcId != null && vpcs.Contains(l.VpcId)).ToList();

        var listeners = new List<V2.Listener>();
        foreach (var lb in lbs)
            listeners.AddRange(await Aws.All(v2.Paginators.DescribeListeners(new V2.DescribeListenersRequest { LoadBalancerArn = lb.LoadBalancerArn }).Listeners, ct));

        var lbArns = lbs.Select(l => l.LoadBalancerArn).ToHashSet(StringComparer.Ordinal);
        var tgs = (await Aws.All(v2.Paginators.DescribeTargetGroups(new V2.DescribeTargetGroupsRequest()).TargetGroups, ct))
            .Where(t => Aws.L(t.LoadBalancerArns).Any(lbArns.Contains)).ToList();
        var health = new Dictionary<string, List<V2.TargetHealthDescription>>(StringComparer.Ordinal);
        foreach (var tg in tgs)
            health[tg.TargetGroupArn] = Aws.L((await v2.DescribeTargetHealthAsync(new V2.DescribeTargetHealthRequest { TargetGroupArn = tg.TargetGroupArn }, ct)).TargetHealthDescriptions);

        var tags = new Dictionary<string, List<V2.Tag>>(StringComparer.Ordinal);
        foreach (var chunk in lbArns.Chunk(20))
            foreach (var d in Aws.L((await v2.DescribeTagsAsync(new V2.DescribeTagsRequest { ResourceArns = chunk.ToList() }, ct)).TagDescriptions))
                if (d.ResourceArn != null) tags[d.ResourceArn] = Aws.L(d.Tags);

        // Classic ELB is optional (legacy API, often not permitted): degrade to none plus a warning.
        var classic = await Fetch.Optional(async () =>
        {
            var elb = await aws.Elb(ct);
            return (await Aws.All(elb.Paginators.DescribeLoadBalancers(new ElbModel.DescribeLoadBalancersRequest()).LoadBalancerDescriptions, ct))
                .Where(c => c.VPCId != null && vpcs.Contains(c.VPCId)).ToList();
        }, new List<ElbModel.LoadBalancerDescription>(), warnings, "classic load balancers");

        var part = LoadBalancerNormalizer.Normalize(ctx, new LoadBalancerData(lbs, listeners, tgs, health, tags, classic));
        part.Warnings.AddRange(warnings);
        return part;
    }
}

public sealed class DnsResolverCollector : ICollector
{
    public CollectorDescriptor Descriptor => Collectors.DnsResolver;

    public async Task<GraphPart> CollectAsync(CollectorContext ctx, IAwsClients aws, CancellationToken ct)
    {
        if (ctx.MemberVpcIds.Count == 0) return new GraphPart();
        var r = await aws.Resolver(ct);
        var endpoints = await Aws.All(r.Paginators.ListResolverEndpoints(new ListResolverEndpointsRequest()).ResolverEndpoints, ct);
        var rules = await Aws.All(r.Paginators.ListResolverRules(new ListResolverRulesRequest()).ResolverRules, ct);
        var assocs = await Aws.All(r.Paginators.ListResolverRuleAssociations(new ListResolverRuleAssociationsRequest()).ResolverRuleAssociations, ct);
        var queryLogs = await Aws.All(r.Paginators.ListResolverQueryLogConfigAssociations(new ListResolverQueryLogConfigAssociationsRequest()).ResolverQueryLogConfigAssociations, ct);
        return DnsResolverNormalizer.Normalize(ctx, new DnsResolverData(endpoints, rules, assocs, queryLogs));
    }
}

/// <summary>Global, once per scope. Runs after all regional units, so load balancers / IPs are in the priors.</summary>
public sealed class DnsZonesCollector : ICollector
{
    public CollectorDescriptor Descriptor => Collectors.DnsZones;
    public const int MaxRecordsScannedPerPublicZone = 20000;

    public async Task<GraphPart> CollectAsync(CollectorContext ctx, IAwsClients aws, CancellationToken ct)
    {
        // No member network was found in full: nothing to attach zones to, and Route53 would answer AccessDenied.
        var members = MembersToQuery(ctx);
        if (members.Count == 0) return new GraphPart();

        // Route53 is a global service pinned to us-east-1 (commercial partition only; GovCloud/China are out of scope for v1).
        var r53 = await aws.Route53(ct);

        var privateZones = new Dictionary<string, (string Name, List<(string VpcId, string Region)> Vpcs)>(StringComparer.Ordinal);
        var warnings = new List<string>();
        foreach (var m in members)
        {
            await Fetch.Optional(async () =>
            {
                string? token = null;
                do
                {
                    var resp = await r53.ListHostedZonesByVPCAsync(new ListHostedZonesByVPCRequest
                    {
                        VPCId = m.NetworkId, VPCRegion = VPCRegion.FindValue(m.Region), NextToken = token,
                    }, ct);
                    foreach (var z in Aws.L(resp.HostedZoneSummaries))
                    {
                        if (!privateZones.TryGetValue(z.HostedZoneId, out var entry)) privateZones[z.HostedZoneId] = entry = (z.Name, new());
                        entry.Vpcs.Add((m.NetworkId, m.Region));
                    }
                    token = resp.NextToken;
                } while (!string.IsNullOrEmpty(token));
                return true;
            }, false, warnings, $"private zones of {m.NetworkId}");
        }

        var zones = new List<HostedZoneInfo>();
        var owned = await Aws.All(r53.Paginators.ListHostedZones(new ListHostedZonesRequest()).HostedZones, ct);
        foreach (var z in owned)
        {
            var id = z.Id.Replace("/hostedzone/", "", StringComparison.Ordinal);
            var isPrivate = z.Config?.PrivateZone ?? false;
            if (isPrivate && !privateZones.ContainsKey(id)) continue;
            var records = await Records(r53, id, isPrivate ? DnsZonesNormalizer.MaxPrivateRecordsPerZone + 1 : MaxRecordsScannedPerPublicZone, ct);
            zones.Add(new HostedZoneInfo(id, z.Name, isPrivate, isPrivate ? privateZones[id].Vpcs : new(), records));
        }
        // Private zones shared from another account are associated but not listed by ListHostedZones: keep the zone, no records.
        foreach (var (id, (name, vpcs)) in privateZones.Where(kv => zones.All(z => z.ZoneId != kv.Key)))
            zones.Add(new HostedZoneInfo(id, name, true, vpcs, new()));

        var part = DnsZonesNormalizer.Normalize(ctx, new DnsZonesData(zones));
        part.Warnings.AddRange(warnings);
        return part;
    }

    /// <summary>Members whose network node was collected in full by an earlier unit. Route53 answers a missing VPC with an
    /// AccessDenied-style error, so members that were not found are skipped rather than queried.</summary>
    public static IReadOnlyList<BlueprintMember> MembersToQuery(CollectorContext ctx)
    {
        var found = ctx.PriorNodes(NodeKinds.Network).Where(n => n.Visibility == Visibilities.Full).Select(n => n.Id).ToHashSet(StringComparer.Ordinal);
        return ctx.ScopeMembers.Where(m => found.Contains(AwsIds.Of(m.Region, NodeKinds.Network, m.NetworkId))).ToList();
    }

    private static async Task<List<ResourceRecordSet>> Records(IAmazonRoute53 r53, string zoneId, int cap, CancellationToken ct)
    {
        var list = new List<ResourceRecordSet>();
        var req = new ListResourceRecordSetsRequest { HostedZoneId = zoneId, MaxItems = "300" };
        while (list.Count < cap)
        {
            var resp = await r53.ListResourceRecordSetsAsync(req, ct);
            list.AddRange(Aws.L(resp.ResourceRecordSets));
            if (resp.IsTruncated != true) break;
            req.StartRecordName = resp.NextRecordName;
            req.StartRecordType = resp.NextRecordType;
            req.StartRecordIdentifier = resp.NextRecordIdentifier;
        }
        return list;
    }
}
