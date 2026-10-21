using Duplo.Extension.NetMap.Core.Aws;
using Duplo.Extension.NetMap.Core.Graph;

namespace Duplo.Extension.NetMap.Core.Scan;

/// <summary>The 9 capability tiles: available / partial / not-readable / none, each with a one-line reason and
/// counts. A denied collector makes its capabilities not-readable (naming the missing permission); a failed one
/// makes them partial.</summary>
public static class CapabilityEvaluator
{
    public static Dictionary<string, CapabilityState> Evaluate(GraphIndex g, IReadOnlyList<BlueprintMember> members, IReadOnlyList<WorkUnit> units)
    {
        var caps = new Dictionary<string, CapabilityState>
        {
            [CapabilityKeys.Egress] = Egress(g),
            [CapabilityKeys.Vpn] = Vpn(g),
            [CapabilityKeys.Transit] = Transit(g),
            [CapabilityKeys.Peering] = Present(g, NodeKinds.Peering, "peering connection(s)"),
            [CapabilityKeys.Inspection] = Inspection(g),
            [CapabilityKeys.Dns] = Dns(g),
            [CapabilityKeys.FlowLogs] = Coverage(g, members, NodeKinds.FlowLogConfig, "flow logs", subnetLevelCounts: true),
            [CapabilityKeys.DnsQueryLogs] = Coverage(g, members, NodeKinds.DnsQueryLogConfig, "DNS query logs", subnetLevelCounts: false),
            [CapabilityKeys.Workloads] = Workloads(g, units),
        };

        var affected = new Dictionary<string, List<WorkUnit>>();
        foreach (var u in units.Where(u => u.Status is UnitStatuses.Denied or UnitStatuses.Failed))
        {
            var d = Collectors.All.FirstOrDefault(c => c.Id == u.Collector);
            if (d == null) continue;
            // workloads weighs its own unit problems against what was read (some clusters readable → partial)
            foreach (var key in d.Capabilities.Where(k => caps.ContainsKey(k) && k != CapabilityKeys.Workloads))
            {
                if (!affected.TryGetValue(key, out var list)) affected[key] = list = new List<WorkUnit>();
                list.Add(u);
            }
        }

        foreach (var (key, list) in affected)
        {
            string Where(IEnumerable<WorkUnit> us) => string.Join(", ", us.Select(x => $"{x.ScopeId} ({x.Region})").Distinct());
            var denied = list.Where(u => u.Status == UnitStatuses.Denied).ToList();
            if (denied.Count > 0)
            {
                var perms = denied.Select(u => u.MissingPermission ?? "a read permission").Distinct();
                caps[key] = new CapabilityState
                {
                    State = CapabilityStates.NotReadable,
                    Reason = $"not readable in {Where(denied)}: missing {string.Join(", ", perms)}",
                    Counts = caps[key].Counts,
                };
            }
            else
            {
                var errors = list.Select(u => u.Error ?? "unknown error").Distinct();
                caps[key] = new CapabilityState
                {
                    State = CapabilityStates.Partial,
                    Reason = $"collection failed in {Where(list)}: {string.Join("; ", errors)}",
                    Counts = caps[key].Counts,
                };
            }
        }
        return caps;
    }

    private static CapabilityState St(string state, string reason, Dictionary<string, int>? counts = null) =>
        new() { State = state, Reason = reason, Counts = counts ?? new() };

    private static readonly HashSet<string> WorkloadCollectors = new(StringComparer.Ordinal) { Collectors.Eks.Id, Collectors.Ecs.Id, Collectors.Lambda.Id };

    /// <summary>EKS / ECS / Lambda: counts of what was read, and which clusters or units could not be read and why.</summary>
    public static CapabilityState Workloads(GraphIndex g, IReadOnlyList<WorkUnit> units)
    {
        var clusters = g.OfKind(NodeKinds.K8sCluster).ToList();
        var readable = clusters.Where(c => c.AttrBool("readable") == true).ToList();
        var counts = new Dictionary<string, int>
        {
            ["clusters"] = clusters.Count, ["clustersReadable"] = readable.Count,
            ["pods"] = g.OfKind(NodeKinds.Pod).Count(), ["services"] = g.OfKind(NodeKinds.K8sService).Count(),
            ["ingresses"] = g.OfKind(NodeKinds.Ingress).Count(), ["networkPolicies"] = g.OfKind(NodeKinds.NetworkPolicy).Count(),
            ["ecsServices"] = g.OfKind(NodeKinds.EcsService).Count(), ["tasks"] = g.OfKind(NodeKinds.EcsTask).Count(),
            ["functions"] = g.OfKind(NodeKinds.LambdaFunction).Count(),
        };
        var problems = clusters.Where(c => c.AttrBool("readable") != true)
            .Select(c => $"{c.Name}: needs {c.AttrString("unreadableReason") ?? "read access"}").ToList();
        foreach (var u in units.Where(u => WorkloadCollectors.Contains(u.Collector) && u.Status is UnitStatuses.Denied or UnitStatuses.Failed))
            problems.Add(u.Status == UnitStatuses.Denied
                ? $"{u.Collector} in {u.ScopeId} ({u.Region}): missing {u.MissingPermission ?? "a read permission"}"
                : $"{u.Collector} in {u.ScopeId} ({u.Region}) failed: {u.Error ?? "unknown error"}");
        var deniedUnits = units.Count(u => WorkloadCollectors.Contains(u.Collector) && u.Status == UnitStatuses.Denied);

        var found = counts["pods"] + counts["services"] + counts["tasks"] + counts["functions"] + counts["ecsServices"];
        var parts = new List<string>();
        if (clusters.Count > 0) parts.Add($"{readable.Count} of {clusters.Count} cluster(s) readable");
        if (found > 0) parts.Add($"{counts["pods"]} pods · {counts["services"]} services · {counts["tasks"]} tasks · {counts["functions"]} functions");
        var summary = string.Join(" · ", parts);
        var why = problems.Count > 0 ? " — " + string.Join("; ", problems.Distinct()) : "";

        if (clusters.Count == 0 && found == 0 && problems.Count == 0) return St(CapabilityStates.None, "no EKS, ECS or Lambda workloads in these networks", counts);
        if (found == 0 && readable.Count == 0 && problems.Count > 0 && (deniedUnits > 0 || clusters.Count > 0))
            return St(CapabilityStates.NotReadable, (summary.Length > 0 ? summary : "not readable") + why, counts);
        return problems.Count > 0 ? St(CapabilityStates.Partial, summary + why, counts) : St(CapabilityStates.Available, summary, counts);
    }

    private static CapabilityState Egress(GraphIndex g)
    {
        var subnets = g.OfKind(NodeKinds.Subnet).Where(s => s.Visibility == Visibilities.Full && s.Membership == Memberships.Blueprint).ToList();
        if (subnets.Count == 0) return St(CapabilityStates.None, "no subnets collected");
        var counts = subnets.GroupBy(s => s.AttrString("egress") ?? "unknown").ToDictionary(x => x.Key, x => x.Count());
        if (counts.Keys.All(k => k == "isolated")) return St(CapabilityStates.None, "no subnet has a default route", counts);
        var problems = counts.Where(kv => EgressAnalyzer.Problem.Contains(kv.Key)).Sum(kv => kv.Value);
        var summary = string.Join(" · ", counts.OrderByDescending(kv => kv.Value).Select(kv => $"{kv.Value} {kv.Key}"));
        return problems > 0
            ? St(CapabilityStates.Partial, $"{problems} subnet(s) with unresolved or broken egress · {summary}", counts)
            : St(CapabilityStates.Available, summary, counts);
    }

    private static CapabilityState Vpn(GraphIndex g)
    {
        var conns = g.OfKind(NodeKinds.VpnConnection).Where(c => c.Visibility != Visibilities.Stub).ToList();
        if (conns.Count == 0) return St(CapabilityStates.None, "no site-to-site VPN connections");
        var up = conns.Sum(c => c.AttrInt("tunnelsUp") ?? 0);
        var total = conns.Sum(c => c.AttrInt("tunnelsTotal") ?? 0);
        var degraded = conns.Count(c => (c.AttrInt("tunnelsTotal") ?? 0) > 0 && (c.AttrInt("tunnelsUp") ?? 0) < 2);
        var counts = new Dictionary<string, int>
        {
            ["connections"] = conns.Count, ["tunnelsUp"] = up, ["tunnelsTotal"] = total, ["degraded"] = degraded,
            ["bgp"] = conns.Count(c => c.AttrString("routing") == "bgp"), ["static"] = conns.Count(c => c.AttrString("routing") == "static"),
        };
        var reason = $"{conns.Count} connection(s) · {up}/{total} tunnels up" + (degraded > 0 ? $" · {degraded} without redundancy" : "");
        return St(degraded > 0 ? CapabilityStates.Partial : CapabilityStates.Available, reason, counts);
    }

    private static CapabilityState Transit(GraphIndex g)
    {
        var hubs = g.OfKind(NodeKinds.Hub).Where(h => h.Visibility != Visibilities.Stub).ToList();
        if (hubs.Count == 0) return St(CapabilityStates.None, "no transit gateways attached");
        var partial = hubs.Count(h => h.Visibility == Visibilities.Partial);
        var counts = new Dictionary<string, int>
        {
            ["hubs"] = hubs.Count, ["attachments"] = g.OfKind(NodeKinds.HubAttachment).Count(), ["routeTables"] = g.OfKind(NodeKinds.HubRouteTable).Count(),
        };
        return partial > 0
            ? St(CapabilityStates.Partial, $"route tables of {partial} hub(s) not readable — owner account not in the blueprint's scopes", counts)
            : St(CapabilityStates.Available, $"{hubs.Count} hub(s) · {counts["attachments"]} attachment(s)", counts);
    }

    private static CapabilityState Present(GraphIndex g, string kind, string label)
    {
        var n = g.OfKind(kind).Count(x => x.Visibility != Visibilities.Stub);
        return n > 0 ? St(CapabilityStates.Available, $"{n} {label}", new() { ["count"] = n }) : St(CapabilityStates.None, $"no {label}");
    }

    private static CapabilityState Inspection(GraphIndex g)
    {
        var gwlbe = g.OfKind(NodeKinds.Endpoint).Count(e => e.AttrString("endpointType") == "GatewayLoadBalancer");
        var nfw = g.OfKind(NodeKinds.FirewallService).Count();
        return gwlbe + nfw > 0
            ? St(CapabilityStates.Available, $"{gwlbe} GWLB endpoint(s) · {nfw} Network Firewall(s)", new() { ["gwlbEndpoints"] = gwlbe, ["firewalls"] = nfw })
            : St(CapabilityStates.None, "no GWLB endpoint or Network Firewall");
    }

    private static CapabilityState Dns(GraphIndex g)
    {
        var counts = new Dictionary<string, int>
        {
            ["zones"] = g.OfKind(NodeKinds.DnsZone).Count(), ["records"] = g.OfKind(NodeKinds.DnsRecord).Count(),
            ["resolverRules"] = g.OfKind(NodeKinds.ResolverRule).Count(), ["resolverEndpoints"] = g.OfKind(NodeKinds.ResolverEndpoint).Count(),
        };
        return counts.Values.Sum() > 0
            ? St(CapabilityStates.Available, $"{counts["zones"]} zone(s) · {counts["records"]} record(s) · {counts["resolverRules"]} resolver rule(s)", counts)
            : St(CapabilityStates.None, "no DNS zones or resolver rules for these networks");
    }

    private static CapabilityState Coverage(GraphIndex g, IReadOnlyList<BlueprintMember> members, string kind, string label, bool subnetLevelCounts)
    {
        var nets = members.Select(m => AwsIds.Of(m.Region, NodeKinds.Network, m.NetworkId)).Distinct(StringComparer.Ordinal)
            .Where(id => g.Node(id) is { Visibility: Visibilities.Full }).ToList();
        if (nets.Count == 0) return St(CapabilityStates.None, "no member networks collected");

        bool Has(string id) => g.Out(id, EdgeKinds.Associated).Any(e => g.Node(e.To)?.Kind == kind);
        bool Covered(string netId)
        {
            if (Has(netId)) return true;
            if (!subnetLevelCounts) return false;
            var subnets = g.Children(netId).Where(c => c.Kind == NodeKinds.Subnet).ToList();
            return subnets.Count > 0 && subnets.All(s => Has(s.Id));
        }

        var covered = nets.Count(Covered);
        var state = covered == nets.Count ? CapabilityStates.Available : covered == 0 ? CapabilityStates.None : CapabilityStates.Partial;
        return St(state, $"{covered} of {nets.Count} member network(s) have {label}", new() { ["covered"] = covered, ["networks"] = nets.Count });
    }
}
