using Duplo.Extension.NetMap.Core.Graph;

namespace Duplo.Extension.NetMap.Core.Scan;

/// <summary>Every edge endpoint that no collector produced becomes a stub node (identity parsed from its canonical
/// id). This is the generic one-hop-outside rule: a TGW route target, a peered VPC, an SG referenced across
/// accounts all show up as stubs instead of dangling lines.</summary>
public static class StubDeriver
{
    public static void AddMissing(Dictionary<string, GraphNode> nodes, IEnumerable<GraphEdge> edges)
    {
        foreach (var id in edges.SelectMany(e => new[] { e.From, e.To }).Distinct(StringComparer.Ordinal))
        {
            if (nodes.ContainsKey(id) || !NodeId.TryParse(id, out var p)) continue;
            nodes[id] = new GraphNode
            {
                Id = id, Kind = p.Kind, Provider = p.Provider, Account = p.Account, Region = p.Region,
                NativeId = p.NativeId, Name = p.NativeId, CollectedBy = "stub",
            }.AsStub();
        }
    }
}
