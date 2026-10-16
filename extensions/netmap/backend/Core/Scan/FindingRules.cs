using Duplo.Extension.NetMap.Core.Aws;
using Duplo.Extension.NetMap.Core.Graph;

namespace Duplo.Extension.NetMap.Core.Scan;

/// <summary>v1 rules. NET-001/002 carry over v0's security-group exposure checks (only groups attached to
/// something); NET-003..005 use data v1 now collects. v3 replaces this with the full, versioned rule catalog.</summary>
public static class FindingRules
{
    public static List<Finding> Evaluate(GraphIndex g, IReadOnlyList<BlueprintMember> members)
    {
        var findings = new List<Finding>();

        foreach (var sg in g.OfKind(NodeKinds.SecurityGroup))
        {
            if (!g.In(sg.Id, EdgeKinds.Uses).Any()) continue;
            var inbound = g.In(sg.Id, EdgeKinds.Allows).Where(e => e.From == NodeId.Internet).ToList();
            if (inbound.Count > 0)
                findings.Add(New("NET-001", Severities.Bad, new[] { sg.Id }, inbound, $"{sg.Name}: inbound {Ports(inbound)} open to the internet"));
            var outbound = g.Out(sg.Id, EdgeKinds.Allows).Where(e => e.To == NodeId.Internet).ToList();
            if (outbound.Count > 0)
                findings.Add(New("NET-002", Severities.Warn, new[] { sg.Id }, outbound, $"{sg.Name}: outbound {Ports(outbound)} to the internet (default-allow)"));
        }

        foreach (var c in g.OfKind(NodeKinds.VpnConnection))
        {
            var total = c.AttrInt("tunnelsTotal") ?? 0;
            var up = c.AttrInt("tunnelsUp") ?? 0;
            if (total > 0 && up < 2)
                findings.Add(New("NET-003", Severities.Warn, new[] { c.Id }, Array.Empty<GraphEdge>(), $"{c.Name}: {up}/{total} tunnels UP — no redundancy"));
        }

        foreach (var e in g.Graph.Edges.Where(e => e.Kind == EdgeKinds.RoutesTo && e.AttrString("state") == "blackhole"))
            findings.Add(New("NET-004", Severities.Bad, new[] { e.From }, new[] { e }, $"{g.Node(e.From)?.Name ?? e.From}: route {e.AttrString("destination")} is a blackhole"));
        foreach (var rt in g.OfKind(NodeKinds.HubRouteTable))
        {
            var bh = rt.AttrStrings("blackholeRoutes").ToList();
            if (bh.Count > 0)
                findings.Add(New("NET-004", Severities.Bad, new[] { rt.Id }, Array.Empty<GraphEdge>(), $"{rt.Name}: blackhole route(s) {string.Join(", ", bh)}"));
        }

        var nets = members.Select(m => g.Node(AwsIds.Of(m.Region, NodeKinds.Network, m.NetworkId))).OfType<GraphNode>()
            .DistinctBy(n => n.Id, StringComparer.Ordinal).ToList();
        for (var i = 0; i < nets.Count; i++)
            for (var j = i + 1; j < nets.Count; j++)
            {
                var pair = nets[i].Cidrs.SelectMany(a => nets[j].Cidrs.Select(b => (a, b))).FirstOrDefault(p => Cidr.Overlaps(p.a, p.b));
                if (pair != default)
                    findings.Add(New("NET-005", Severities.Warn, new[] { nets[i].Id, nets[j].Id }, Array.Empty<GraphEdge>(),
                        $"{nets[i].Name} {pair.a} overlaps {nets[j].Name} {pair.b}"));
            }

        return findings;
    }

    private static Finding New(string rule, string severity, IEnumerable<string> nodes, IEnumerable<GraphEdge> edges, string message) =>
        new() { RuleId = rule, Severity = severity, NodeIds = nodes.ToList(), EdgeIds = edges.Select(e => e.Id).ToList(), Message = message };

    private static string Ports(IEnumerable<GraphEdge> edges) => string.Join(", ", edges.Select(e =>
    {
        var proto = e.AttrString("protocol") ?? "all";
        if (proto == "all") return "all traffic";
        var from = e.Attrs.GetValueOrDefault("fromPort")?.ToString();
        var to = e.Attrs.GetValueOrDefault("toPort")?.ToString();
        return from == null ? proto : from == to ? $"{proto}/{from}" : $"{proto}/{from}-{to}";
    }).Distinct());
}
