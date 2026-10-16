using Duplo.Extension.NetMap.Core.Graph;

namespace Duplo.Extension.NetMap.Core.Scan;

/// <summary>Synthetic account containers (the L1 grouping). Accounts covered by a blueprint scope are full and
/// named after the scope(s); accounts only seen through sharing/peering are partial and outside the blueprint.</summary>
public static class AccountNodes
{
    public static void Add(Dictionary<string, GraphNode> nodes, IReadOnlyDictionary<string, string> scopeAccounts, IReadOnlyDictionary<string, string> scopeNames, DateTime now)
    {
        var scopesByAccount = scopeAccounts.GroupBy(kv => kv.Value, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Select(kv => scopeNames.GetValueOrDefault(kv.Key, kv.Key)).OrderBy(s => s, StringComparer.Ordinal).ToList(), StringComparer.Ordinal);

        var referenced = nodes.Values.Select(n => n.ParentId).OfType<string>()
            .Where(p => NodeId.TryParse(p, out var parts) && parts.Kind == NodeKinds.Account).Distinct(StringComparer.Ordinal).ToList();

        foreach (var id in referenced)
        {
            if (nodes.ContainsKey(id)) continue;
            var p = NodeId.Parse(id);
            var account = p.NativeId;
            var inScope = scopesByAccount.TryGetValue(account, out var names);
            var n = new GraphNode
            {
                Id = id, Kind = NodeKinds.Account, Provider = p.Provider, Region = "global", NativeId = account,
                Account = account, OwnerAccount = account, CollectedBy = "finalize", CollectedAt = now,
                Name = inScope ? $"{string.Join(", ", names!)} · {account}" : account,
            };
            n.Attr("inScope", inScope);
            if (!inScope) { n.Visibility = Visibilities.Partial; n.Membership = Memberships.Outside; }
            nodes[id] = n;
        }
    }
}
