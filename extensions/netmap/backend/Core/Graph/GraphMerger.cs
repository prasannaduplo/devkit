namespace Duplo.Extension.NetMap.Core.Graph;

/// <summary>Merges work-unit parts by canonical id. The same object seen by several units or scopes becomes one
/// node: the most visible sighting wins (full > partial > stub; ties → the later collection), tags/CIDRs/scopes are
/// unioned, and missing attributes are filled from the other sighting.</summary>
public static class GraphMerger
{
    public static (List<GraphNode> Nodes, List<GraphEdge> Edges) Merge(IEnumerable<GraphPart> parts)
    {
        var nodes = new Dictionary<string, GraphNode>(StringComparer.Ordinal);
        var edges = new Dictionary<string, GraphEdge>(StringComparer.Ordinal);

        foreach (var part in parts)
        {
            foreach (var n in part.Nodes)
                nodes[n.Id] = nodes.TryGetValue(n.Id, out var existing) ? Combine(existing, n) : n;

            foreach (var e in part.Edges)
            {
                if (!edges.TryGetValue(e.Id, out var existing)) { edges[e.Id] = e; continue; }
                foreach (var (k, v) in e.Attrs) existing.Attrs[k] = v?.DeepClone();
            }
        }

        foreach (var n in nodes.Values)
            if (n.Name == n.NativeId && n.AttrString("nameHint") is { Length: > 0 } hint) n.Name = hint;

        return (nodes.Values.ToList(), edges.Values.ToList());
    }

    internal static GraphNode Combine(GraphNode a, GraphNode b)
    {
        var ra = Visibilities.Rank(a.Visibility);
        var rb = Visibilities.Rank(b.Visibility);
        var (win, other) = ra != rb ? (ra > rb ? (a, b) : (b, a)) : (b.CollectedAt >= a.CollectedAt ? (b, a) : (a, b));

        foreach (var (k, v) in other.Tags) win.Tags.TryAdd(k, v);
        foreach (var c in other.Cidrs) if (!win.Cidrs.Contains(c)) win.Cidrs.Add(c);
        foreach (var s in other.SeenFrom) if (!win.SeenFrom.Contains(s)) win.SeenFrom.Add(s);
        foreach (var (k, v) in other.Attrs) if (!win.Attrs.ContainsKey(k)) win.Attrs[k] = v?.DeepClone();

        win.Raw ??= other.Raw?.DeepClone().AsObject();
        win.ParentId ??= other.ParentId;
        win.State ??= other.State;
        win.NativeState ??= other.NativeState;
        win.Account ??= other.Account;
        win.OwnerAccount ??= other.OwnerAccount;
        if ((win.Name == win.NativeId || string.IsNullOrEmpty(win.Name)) && other.Name != other.NativeId) win.Name = other.Name;
        if (other.Membership == Memberships.Blueprint) win.Membership = Memberships.Blueprint;
        return win;
    }
}
