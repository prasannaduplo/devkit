using Duplo.Extension.NetMap.Core.Graph;

namespace Duplo.Extension.NetMap.Core.Scan;

/// <summary>Account id per scope. Primary source is the scope (Provider.AccountId); when a scope does not carry a
/// 12-digit id, the owner of the VPCs its core-network unit collected is used.</summary>
public static class ScanAccounts
{
    public static Dictionary<string, string> Fill(IReadOnlyDictionary<string, string> fromScopes, IEnumerable<WorkUnit> units)
    {
        var result = new Dictionary<string, string>(fromScopes, StringComparer.Ordinal);
        foreach (var u in units.Where(u => u.Collector == Collectors.CoreNetwork.Id && u.Status == UnitStatuses.Done && u.Part != null))
        {
            if (result.ContainsKey(u.ScopeId)) continue;
            var account = FromParts(new[] { GraphCodec.Decode<GraphPart>(u.Part!) });
            if (account != null) result[u.ScopeId] = account;
        }
        return result;
    }

    public static string? FromParts(IEnumerable<GraphPart> parts) =>
        parts.SelectMany(p => p.Nodes).FirstOrDefault(n => n.Kind == NodeKinds.Network && n.Visibility == Visibilities.Full && n.Account != null)?.Account;
}
