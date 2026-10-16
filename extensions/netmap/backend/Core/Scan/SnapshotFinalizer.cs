using Duplo.Extension.NetMap.Core.Graph;

namespace Duplo.Extension.NetMap.Core.Scan;

public sealed record FinalizeInput(
    IReadOnlyList<BlueprintMember> Members, IReadOnlyList<WorkUnit> Units,
    IReadOnlyDictionary<string, string> ScopeAccounts, IReadOnlyDictionary<string, string> ScopeNames, DateTime Now);

public sealed record FinalizeOutput(NetworkGraph Graph, SnapshotSummary Summary, List<MemberStatus> MemberStatuses, string ScanStatus, string ContentHash);

/// <summary>All units finished → one graph: merge parts, derive stubs and account containers, annotate egress,
/// evaluate findings, capabilities and member statuses, and hash. Status: failed (nothing collected), partial (any
/// unit failed/denied), complete.</summary>
public static class SnapshotFinalizer
{
    public static FinalizeOutput Finalize(FinalizeInput input)
    {
        var parts = input.Units.Where(u => u.Status == UnitStatuses.Done && u.Part != null)
            .Select(u => GraphCodec.Decode<GraphPart>(u.Part!)).ToList();
        var (nodes, edges) = GraphMerger.Merge(parts);
        var map = nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);
        StubDeriver.AddMissing(map, edges);
        AccountNodes.Add(map, input.ScopeAccounts, input.ScopeNames, input.Now);
        // A parent that was never collected (or not derivable) would leave the node orphaned in the UI's nesting: drop the link.
        foreach (var n in map.Values.Where(n => n.ParentId != null && !map.ContainsKey(n.ParentId)))
            n.ParentId = null;

        var graph = new NetworkGraph
        {
            Nodes = map.Values.OrderBy(n => n.Id, StringComparer.Ordinal).ToList(),
            Edges = edges.OrderBy(e => e.Id, StringComparer.Ordinal).ToList(),
        };
        var index = new GraphIndex(graph);
        EgressAnalyzer.Annotate(index);
        graph.Findings = FindingRules.Evaluate(index, input.Members);
        var capabilities = CapabilityEvaluator.Evaluate(index, input.Members, input.Units);
        var members = MemberStatusEvaluator.Evaluate(index, input.Members, input.Units);

        var done = input.Units.Count(u => u.Status == UnitStatuses.Done);
        var failed = input.Units.Count(u => u.Status == UnitStatuses.Failed);
        var denied = input.Units.Count(u => u.Status == UnitStatuses.Denied);
        var status = done == 0 ? ScanStatuses.Failed : failed + denied > 0 ? ScanStatuses.Partial : ScanStatuses.Complete;

        var summary = new SnapshotSummary
        {
            Status = status,
            FinishedAt = input.Now,
            NodeCount = graph.Nodes.Count(n => n.Visibility != Visibilities.Stub),
            StubCount = graph.Nodes.Count(n => n.Visibility == Visibilities.Stub),
            EdgeCount = graph.Edges.Count,
            KindCounts = graph.Nodes.GroupBy(n => n.Kind).ToDictionary(g => g.Key, g => g.Count()),
            Capabilities = capabilities,
            FindingsBad = graph.Findings.Count(f => f.Severity == Severities.Bad),
            FindingsWarn = graph.Findings.Count(f => f.Severity == Severities.Warn),
            UnitsTotal = input.Units.Count,
            UnitsDone = done,
            UnitsFailed = failed,
            UnitsDenied = denied,
            UnitProblems = input.Units.Where(u => u.Status is UnitStatuses.Failed or UnitStatuses.Denied)
                .Select(u => u.Status == UnitStatuses.Denied
                    ? $"{u.Collector} @ {u.ScopeId}/{u.Region}: denied — missing {u.MissingPermission ?? "a read permission"}"
                    : $"{u.Collector} @ {u.ScopeId}/{u.Region}: failed — {u.Error}")
                .Concat(parts.SelectMany(p => p.Warnings).Distinct(StringComparer.Ordinal).Select(w => "warning: " + w))
                .ToList(),
        };

        return new FinalizeOutput(graph, summary, members, status, GraphCodec.ContentHash(graph));
    }
}
