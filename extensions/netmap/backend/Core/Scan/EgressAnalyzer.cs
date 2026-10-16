using Duplo.Extension.NetMap.Core.Graph;

namespace Duplo.Extension.NetMap.Core.Scan;

/// <summary>Per subnet: where does the IPv4 default route (0.0.0.0/0) go? Writes attrs egress / egressTarget /
/// egressRoute on each full subnet. One hop only -- following the hub onward is the v2 path engine.
/// Classes: direct, via-nat, via-private-nat, nat-no-igw, via-hub, via-hub-partial, via-inspection, via-peering,
/// via-appliance, via-vpn, nat-unavailable, blackhole, unknown, isolated.</summary>
public static class EgressAnalyzer
{
    public static readonly IReadOnlySet<string> Problem = new HashSet<string> { "via-hub-partial", "nat-no-igw", "blackhole", "unknown", "nat-unavailable" };

    public static void Annotate(GraphIndex g)
    {
        foreach (var subnet in g.OfKind(NodeKinds.Subnet).Where(s => s.Visibility == Visibilities.Full).ToList())
        {
            var (cls, target, route) = Classify(g, RouteTableOf(g, subnet.Id));
            subnet.Attr("egress", cls).Attr("egressTarget", target).Attr("egressRoute", route);
        }
    }

    private static GraphNode? RouteTableOf(GraphIndex g, string subnetId) =>
        g.Out(subnetId, EdgeKinds.Associated).Select(e => g.Node(e.To)).FirstOrDefault(n => n?.Kind == NodeKinds.RouteTable);

    private static GraphEdge? DefaultRoute(GraphIndex g, GraphNode rt) =>
        g.Out(rt.Id, EdgeKinds.RoutesTo).FirstOrDefault(e => e.AttrString("destination") == "0.0.0.0/0");

    private static (string Class, string? Target, string? Route) Classify(GraphIndex g, GraphNode? rt)
    {
        if (rt == null || DefaultRoute(g, rt) is not { } route) return ("isolated", null, null);
        if (route.AttrString("state") == "blackhole") return ("blackhole", route.To, route.Id);

        var target = g.Node(route.To);
        var kind = target?.Kind ?? (NodeId.TryParse(route.To, out var p) ? p.Kind : "");
        var cls = kind switch
        {
            NodeKinds.InternetGateway => "direct",
            NodeKinds.NatGateway => NatClass(g, target),
            NodeKinds.Hub => target is { Visibility: Visibilities.Full } ? "via-hub" : "via-hub-partial",
            NodeKinds.Endpoint => "via-inspection",
            NodeKinds.Peering => "via-peering",
            NodeKinds.VpnGateway => "via-vpn",
            NodeKinds.NetworkInterface or NodeKinds.Workload => "via-appliance",
            _ => "unknown",
        };
        return (cls, route.To, route.Id);
    }

    private static string NatClass(GraphIndex g, GraphNode? nat)
    {
        if (nat == null) return "unknown";
        if (nat.State is "failed" or "deleted") return "nat-unavailable";
        if (nat.AttrString("connectivityType") == "private") return "via-private-nat";
        var natRt = nat.ParentId == null ? null : RouteTableOf(g, nat.ParentId);
        var r = natRt == null ? null : DefaultRoute(g, natRt);
        return r != null && g.Node(r.To)?.Kind == NodeKinds.InternetGateway ? "via-nat" : "nat-no-igw";
    }
}
