namespace Duplo.Extension.NetMap.Core.Scan;

/// <summary>Members → the ordered list of work units for one scan. List order is execution order: every regional
/// group's collectors in descriptor order, then each scope's global collectors.</summary>
public static class ScanPlanner
{
    public const string GlobalRegion = "global";

    public static List<WorkUnit> Plan(IEnumerable<BlueprintMember> members, IReadOnlyList<CollectorDescriptor> collectors)
    {
        var list = members.ToList();
        var units = new List<WorkUnit>();
        var groups = list.Select(m => (m.ScopeId, m.Region)).Distinct()
            .OrderBy(g => g.ScopeId, StringComparer.Ordinal).ThenBy(g => g.Region, StringComparer.Ordinal);

        foreach (var (scope, region) in groups)
            foreach (var c in collectors.Where(c => !c.Global).OrderBy(c => c.Order))
                units.Add(New(c, scope, region));

        foreach (var scope in list.Select(m => m.ScopeId).Distinct().OrderBy(s => s, StringComparer.Ordinal))
            foreach (var c in collectors.Where(c => c.Global).OrderBy(c => c.Order))
                units.Add(New(c, scope, GlobalRegion));

        return units;
    }

    private static WorkUnit New(CollectorDescriptor c, string scope, string region) => new()
    {
        Id = $"{c.Id}|{scope}|{region}", Collector = c.Id, ScopeId = scope, Region = region, Order = c.Order,
    };
}
