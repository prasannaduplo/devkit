using Amazon.Route53.Model;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Core.Aws.Normalize;

/// <param name="ZoneId">Without the "/hostedzone/" prefix.</param>
/// <param name="Vpcs">Member VPCs this private zone is associated with (from ListHostedZonesByVPC).</param>
public sealed record HostedZoneInfo(string ZoneId, string Name, bool Private, List<(string VpcId, string Region)> Vpcs, List<ResourceRecordSet> Records);

public sealed record DnsZonesData(List<HostedZoneInfo> Zones);

/// <summary>Route53 hosted zones (global, once per scope). Private zones associated with member VPCs keep their
/// records (capped); public zones keep only records that resolve to collected load balancers or IPs -- "which
/// domains point at this network". Needs the load-balancer and interface/core parts of the same scope.</summary>
public static class DnsZonesNormalizer
{
    public static readonly string Collector = Collectors.DnsZones.Id;
    public const int MaxPrivateRecordsPerZone = 5000;

    public static GraphPart Normalize(CollectorContext ctx, DnsZonesData d)
    {
        var b = ctx.Builder(Collector);
        var lbByDns = ctx.PriorNodes(NodeKinds.LoadBalancer).Where(n => n.AttrString("dnsName") != null)
            .GroupBy(n => NormDns(n.AttrString("dnsName")!)).ToDictionary(g => g.Key, g => g.First().Id, StringComparer.Ordinal);
        var byIp = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pip in ctx.PriorNodes(NodeKinds.PublicIp)) if (pip.AttrString("ip") is { } ip) byIp.TryAdd(ip, pip.Id);
        foreach (var eni in ctx.PriorNodes(NodeKinds.NetworkInterface)) foreach (var ip in eni.AttrStrings("privateIps")) byIp.TryAdd(ip, eni.Id);

        foreach (var z in d.Zones)
        {
            if (z.Private && z.Vpcs.Count == 0) continue;
            GraphNode? zone = null;
            GraphNode EnsureZone()
            {
                if (zone != null) return zone;
                zone = b.Node(AwsIds.Of("global", NodeKinds.DnsZone, z.ZoneId), NodeKinds.DnsZone, z.ZoneId, ctx.Account, "global")
                    .Named(z.Name.TrimEnd('.')).Under(ctx.AccountId(null)).Attr("private", z.Private).Attr("recordCount", z.Records.Count);
                foreach (var (vpc, region) in z.Vpcs) b.Edge(ctx.NetworkId(vpc, region), EdgeKinds.Associated, zone.Id);
                return zone;
            }
            if (z.Private) EnsureZone();

            var kept = 0;
            foreach (var r in z.Records)
            {
                var type = r.Type?.Value ?? "";
                if (type is "SOA" or "NS") continue;
                var values = r.AliasTarget?.DNSName is { } alias ? new List<string> { alias } : Aws.L(r.ResourceRecords).Select(x => x.Value).OfType<string>().ToList();
                var targets = values.Select(v => Resolve(v, lbByDns, byIp)).OfType<string>().Distinct().ToList();
                if (!z.Private && targets.Count == 0) continue;
                if (z.Private && ++kept > MaxPrivateRecordsPerZone) { EnsureZone().Attr("truncated", true); break; }

                var native = $"{z.ZoneId}/{r.Name}/{type}/{r.SetIdentifier}";
                var rec = b.Node(AwsIds.Of("global", NodeKinds.DnsRecord, native), NodeKinds.DnsRecord, native, ctx.Account, "global")
                    .Named(r.Name?.TrimEnd('.')).Under(EnsureZone().Id).Attr("recordType", type).Attr("values", NodeExtensions.Arr(values))
                    .Attr("alias", r.AliasTarget != null).Attr("ttl", r.TTL);
                foreach (var t in targets) b.Edge(rec.Id, EdgeKinds.ResolvesTo, t);
            }
        }

        return b.Build();
    }

    private static string? Resolve(string value, Dictionary<string, string> lbByDns, Dictionary<string, string> byIp) =>
        lbByDns.TryGetValue(NormDns(value), out var lb) ? lb : byIp.TryGetValue(value, out var ip) ? ip : null;

    internal static string NormDns(string dns)
    {
        var s = dns.Trim().TrimEnd('.').ToLowerInvariant();
        return s.StartsWith("dualstack.", StringComparison.Ordinal) ? s["dualstack.".Length..] : s;
    }
}
