namespace Duplo.Extension.NetMap.Core.Graph;

/// <summary>Read-side lookups over a finalized graph for the evaluators (egress, capabilities, findings).</summary>
public sealed class GraphIndex
{
    private readonly Dictionary<string, GraphNode> _nodes;
    private readonly ILookup<string, GraphEdge> _out;
    private readonly ILookup<string, GraphEdge> _in;
    private readonly ILookup<string, GraphNode> _children;

    public GraphIndex(NetworkGraph graph)
    {
        Graph = graph;
        _nodes = graph.Nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);
        _out = graph.Edges.ToLookup(e => e.From, StringComparer.Ordinal);
        _in = graph.Edges.ToLookup(e => e.To, StringComparer.Ordinal);
        _children = graph.Nodes.Where(n => n.ParentId != null).ToLookup(n => n.ParentId!, StringComparer.Ordinal);
    }

    public NetworkGraph Graph { get; }

    public GraphNode? Node(string id) => _nodes.GetValueOrDefault(id);
    public IEnumerable<GraphEdge> Out(string id, string? kind = null) => _out[id].Where(e => kind == null || e.Kind == kind);
    public IEnumerable<GraphEdge> In(string id, string? kind = null) => _in[id].Where(e => kind == null || e.Kind == kind);
    public IEnumerable<GraphNode> Children(string id) => _children[id];
    public IEnumerable<GraphNode> OfKind(string kind) => Graph.Nodes.Where(n => n.Kind == kind);
}
