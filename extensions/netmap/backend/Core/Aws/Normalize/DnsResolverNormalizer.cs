using Amazon.Route53Resolver.Model;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Core.Aws.Normalize;

public sealed record DnsResolverData(
    List<ResolverEndpoint> Endpoints, List<ResolverRule> Rules, List<ResolverRuleAssociation> RuleAssociations,
    List<ResolverQueryLogConfigAssociation> QueryLogAssociations);

/// <summary>Route53 Resolver (regional): endpoints hosted in member VPCs, forwarding rules associated with them
/// (hybrid DNS to on-prem), and query-log associations (the "DNS query logs available" capability).</summary>
public static class DnsResolverNormalizer
{
    public static readonly string Collector = Collectors.DnsResolver.Id;

    public static GraphPart Normalize(CollectorContext ctx, DnsResolverData d)
    {
        var b = ctx.Builder(Collector);
        var members = new HashSet<string>(ctx.MemberVpcIds, StringComparer.Ordinal);

        foreach (var ep in d.Endpoints.Where(e => e.HostVPCId != null && members.Contains(e.HostVPCId)))
        {
            var n = b.Node(ctx.Id(NodeKinds.ResolverEndpoint, ep.Id), NodeKinds.ResolverEndpoint, ep.Id, ctx.Account, ctx.Region)
                .Named(ep.Name).Under(ctx.NetworkId(ep.HostVPCId)).SetState(ep.Status?.Value)
                .Attr("direction", ep.Direction?.Value).Attr("ipCount", ep.IpAddressCount);
            n.Raw = RawJson.From(ep);
            foreach (var sg in Aws.L(ep.SecurityGroupIds)) b.Edge(n.Id, EdgeKinds.Uses, ctx.Id(NodeKinds.SecurityGroup, sg));
        }

        var rules = d.Rules.Where(r => r.Id != null).ToDictionary(r => r.Id, StringComparer.Ordinal);
        foreach (var assoc in d.RuleAssociations.Where(a => a.VPCId != null && members.Contains(a.VPCId)))
        {
            if (assoc.ResolverRuleId == null || !rules.TryGetValue(assoc.ResolverRuleId, out var rule)) continue;
            var n = b.Node(ctx.Id(NodeKinds.ResolverRule, rule.Id), NodeKinds.ResolverRule, rule.Id, rule.OwnerId ?? ctx.Account, ctx.Region)
                .Named(rule.Name ?? rule.DomainName).Under(ctx.AccountId(rule.OwnerId)).SetState(rule.Status?.Value)
                .Attr("domain", rule.DomainName?.TrimEnd('.')).Attr("ruleType", rule.RuleType?.Value).Attr("shareStatus", rule.ShareStatus?.Value)
                .Attr("targetIps", NodeExtensions.Arr(Aws.L(rule.TargetIps).Where(t => t.Ip != null).Select(t => $"{t.Ip}:{t.Port ?? 53}")));
            n.Raw = RawJson.From(rule);
            b.Edge(ctx.NetworkId(assoc.VPCId), EdgeKinds.Associated, n.Id);
            if (rule.ResolverEndpointId != null) b.Edge(n.Id, EdgeKinds.Uses, ctx.Id(NodeKinds.ResolverEndpoint, rule.ResolverEndpointId));
            foreach (var t in Aws.L(rule.TargetIps).Where(t => t.Ip != null))
                b.Edge(n.Id, EdgeKinds.ForwardsTo, InterfacesNormalizer.EnsureCidr(b, t.Ip + "/32")).Attr("port", t.Port ?? 53);
        }

        foreach (var q in d.QueryLogAssociations.Where(q => q.ResourceId != null && members.Contains(q.ResourceId)))
        {
            var n = b.Node(ctx.Id(NodeKinds.DnsQueryLogConfig, q.Id), NodeKinds.DnsQueryLogConfig, q.Id, ctx.Account, ctx.Region)
                .Under(ctx.NetworkId(q.ResourceId)).SetState(q.Status?.Value).Attr("configId", q.ResolverQueryLogConfigId);
            n.Raw = RawJson.From(q);
            b.Edge(ctx.NetworkId(q.ResourceId), EdgeKinds.Associated, n.Id);
        }

        return b.Build();
    }
}
