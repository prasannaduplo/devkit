using System.Text.Json.Nodes;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;

namespace Duplo.Extension.NetMap.Core.Aws.Normalize;

/// <summary>Shared lookups the workload normalizers make over earlier parts (interfaces, load balancers).</summary>
internal sealed class WorkloadLinks
{
    private readonly Dictionary<(string Vpc, string Ip), string> _eniByVpcIp = new();
    private readonly Dictionary<string, GraphNode> _enis = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _lbByDns = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _workloads = new(StringComparer.Ordinal);

    public List<(string LbId, string Ip, GraphEdge Edge)> IpTargets { get; } = new();
    public List<GraphNode> LoadBalancers { get; } = new();

    public WorkloadLinks(CollectorContext ctx)
    {
        foreach (var e in ctx.PriorNodes(NodeKinds.NetworkInterface))
        {
            _enis[e.Id] = e;
            var vpc = e.AttrString("vpcId") ?? "";
            foreach (var ip in e.AttrStrings("privateIps").Append(e.AttrString("privateIp")).OfType<string>())
                _eniByVpcIp.TryAdd((vpc, ip), e.Id);
        }
        foreach (var lb in ctx.PriorNodes(NodeKinds.LoadBalancer))
        {
            LoadBalancers.Add(lb);
            if (lb.AttrString("dnsName") is { } dns) _lbByDns.TryAdd(NormDns(dns), lb.Id);
        }
        foreach (var w in ctx.PriorNodes(NodeKinds.Workload)) _workloads.Add(w.Id);
        foreach (var edge in ctx.Priors.SelectMany(p => p.Edges).Where(e => e.Kind == EdgeKinds.Targets))
            if (edge.AttrString("targetIp") is { } ip) IpTargets.Add((edge.From, ip, edge));
    }

    public string? EniFor(string vpcId, string? ip) => ip != null && _eniByVpcIp.TryGetValue((vpcId, ip), out var id) ? id : null;

    public GraphNode? Eni(string id) => _enis.GetValueOrDefault(id);

    public IEnumerable<GraphNode> Enis => _enis.Values;

    public bool HasWorkload(string id) => _workloads.Contains(id);

    public string? LbByDns(string host) => _lbByDns.TryGetValue(NormDns(host), out var id) ? id : null;

    public static string NormDns(string s) => s.Trim().TrimEnd('.').ToLowerInvariant().Replace("dualstack.", "");

    /// <summary>load balancer → workload for ip-mode targets whose address is the workload's (pod IP, task IP).</summary>
    public void Exposes(PartBuilder b, IReadOnlyDictionary<string, string> workloadByIp)
    {
        foreach (var (lbId, ip, edge) in IpTargets)
        {
            if (!workloadByIp.TryGetValue(ip, out var wid)) continue;
            b.Edge(lbId, EdgeKinds.Exposes, wid, edge.Attrs.GetValueOrDefault("port")?.ToString() ?? "")
                .Attr("targetGroup", edge.AttrString("targetGroup")).Attr("port", edge.Attrs.GetValueOrDefault("port")?.DeepClone())
                .Attr("protocol", edge.AttrString("protocol")).Attr("health", edge.AttrString("health")).Attr("targetIp", ip);
        }
    }

    public static JsonArray Containers(IEnumerable<(string Name, string Image)> cs) =>
        new(cs.Select(c => (JsonNode?)new JsonObject { ["name"] = c.Name, ["image"] = c.Image }).ToArray());

    public static JsonObject Map(IEnumerable<KeyValuePair<string, string>> kv) =>
        new(kv.Select(x => KeyValuePair.Create(x.Key, (JsonNode?)x.Value)));
}
