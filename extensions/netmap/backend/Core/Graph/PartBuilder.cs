namespace Duplo.Extension.NetMap.Core.Graph;

/// <summary>De-duplicating builder every normalizer writes through: one node per id, one edge per
/// (from, kind, to, qualifier), all stamped with the collector, scope and collection time.</summary>
public sealed class PartBuilder
{
    private readonly Dictionary<string, GraphNode> _nodes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, GraphEdge> _edges = new(StringComparer.Ordinal);
    private readonly string _collector;
    private readonly string _scopeId;
    private readonly DateTime _now;

    public PartBuilder(string collector, string scopeId, DateTime now)
    {
        _collector = collector;
        _scopeId = scopeId;
        _now = now;
    }

    public GraphNode Node(string id, string kind, string nativeId, string? account, string? region, string provider = "aws")
    {
        if (_nodes.TryGetValue(id, out var existing)) return existing;
        var n = new GraphNode
        {
            Id = id, Kind = kind, Provider = provider, Account = account, OwnerAccount = account, Region = region,
            NativeId = nativeId, Name = nativeId, CollectedBy = _collector, CollectedAt = _now,
        };
        n.SeenFrom.Add(_scopeId);
        _nodes[id] = n;
        return n;
    }

    public GraphEdge Edge(string from, string kind, string to, string qualifier = "")
    {
        var id = EdgeId.For(from, kind, to, qualifier);
        if (_edges.TryGetValue(id, out var existing)) return existing;
        var e = new GraphEdge { Id = id, From = from, Kind = kind, To = to };
        _edges[id] = e;
        return e;
    }

    public bool Has(string id) => _nodes.ContainsKey(id);

    public GraphPart Build() => new() { Nodes = _nodes.Values.ToList(), Edges = _edges.Values.ToList() };
}
