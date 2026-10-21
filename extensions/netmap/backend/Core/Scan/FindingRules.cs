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

        findings.AddRange(Workloads(g));
        return findings;
    }

    /// <summary>Egress classes (EgressAnalyzer) under which a Lambda ENI, which never has a public IP, can reach the internet.</summary>
    private static readonly HashSet<string> LambdaInternet = new(StringComparer.Ordinal) { "via-nat", "via-hub", "via-inspection", "via-appliance", "via-private-nat", "via-vpn", "via-peering", "via-hub-partial" };

    /// <summary>v2b workload rules: public LoadBalancer services, namespaces without NetworkPolicy, ECS tasks with a
    /// public IP, Lambda functions without internet egress.</summary>
    public static IEnumerable<Finding> Workloads(GraphIndex g)
    {
        foreach (var s in g.OfKind(NodeKinds.K8sService).Where(s => s.AttrString("serviceType") == "LoadBalancer" && s.AttrString("scheme") == "internet-facing"))
        {
            var lbs = g.Out(s.Id, EdgeKinds.Backs).Select(e => e.To).Where(id => g.Node(id)?.Kind == NodeKinds.LoadBalancer);
            yield return New("k8s-service-public-lb", Severities.Warn, new[] { s.Id }.Concat(lbs), Array.Empty<GraphEdge>(),
                $"{s.AttrString("namespace")}/{s.Name}: Service type LoadBalancer is internet-facing");
        }

        foreach (var ns in g.OfKind(NodeKinds.K8sNamespace))
        {
            var kids = g.Children(ns.Id).ToList();
            var pods = kids.Count(k => k.Kind == NodeKinds.Pod);
            if (pods > 0 && !kids.Any(k => k.Kind == NodeKinds.NetworkPolicy))
                yield return New("k8s-namespace-no-networkpolicy", Severities.Warn, new[] { ns.Id }, Array.Empty<GraphEdge>(),
                    $"{ns.AttrString("cluster")}/{ns.Name}: {pods} pod(s) and no NetworkPolicy — all pod traffic is allowed");
        }

        foreach (var t in g.OfKind(NodeKinds.EcsTask).Where(t => !string.IsNullOrEmpty(t.AttrString("publicIp"))))
            yield return New("ecs-task-public-ip", Severities.Warn, new[] { t.Id }, Array.Empty<GraphEdge>(),
                $"{t.Name}: ECS task has public IP {t.AttrString("publicIp")}");

        foreach (var f in g.OfKind(NodeKinds.LambdaFunction))
        {
            var subnets = g.Out(f.Id, EdgeKinds.PlacedIn).Select(e => g.Node(e.To)).OfType<GraphNode>().Where(s => s.Kind == NodeKinds.Subnet).ToList();
            if (subnets.Count == 0) continue;
            var without = subnets.Where(s => !LambdaInternet.Contains(s.AttrString("egress") ?? "")).ToList();
            if (without.Count == 0) continue;
            var net = f.ParentId;
            var endpoints = g.Graph.Nodes.Count(n => n.Kind == NodeKinds.Endpoint && n.ParentId != null && (n.ParentId == net || g.Node(n.ParentId)?.ParentId == net));
            var direct = without.Where(s => s.AttrString("egress") == "direct").Select(s => s.Name).ToList();
            var names = string.Join(", ", without.Select(s => $"{s.Name} ({s.AttrString("egress") ?? "unknown"})"));
            var all = without.Count == subnets.Count;
            var msg = direct.Count > 0
                ? $"{f.Name}: subnet(s) {string.Join(", ", direct)} route 0.0.0.0/0 to an internet gateway, but Lambda interfaces never get a public IP — no internet egress there"
                : $"{f.Name}: no NAT / internet route from {(all ? "any of its subnets" : "some of its subnets")}: {names}"
                  + (endpoints > 0 ? $"; {endpoints} VPC endpoint(s) in the network" : "; no VPC endpoints either");
            var severity = direct.Count > 0 || !all || endpoints == 0 ? Severities.Warn : Severities.Ok;
            yield return New("lambda-no-egress", severity, new[] { f.Id }.Concat(without.Select(s => s.Id)), Array.Empty<GraphEdge>(), msg);
        }
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
