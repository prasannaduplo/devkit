using System.Security.Cryptography;
using System.Text;

namespace Duplo.Extension.NetMap.Core.Scan;

/// <summary>Spec-level rules for a blueprint's members. Thrown ArgumentExceptions become HTTP 400 with the message.</summary>
public static class BlueprintRules
{
    public static readonly IReadOnlySet<string> SupportedProviders = new HashSet<string> { "aws" };

    public static void Normalize(List<BlueprintMember> members)
    {
        foreach (var m in members)
        {
            m.ScopeId = (m.ScopeId ?? "").Trim();
            m.Region = (m.Region ?? "").Trim();
            m.NetworkId = (m.NetworkId ?? "").Trim();
            m.Provider = string.IsNullOrWhiteSpace(m.Provider) ? "aws" : m.Provider.Trim().ToLowerInvariant();
            m.Cidrs ??= new List<string>();
        }
    }

    public static void Validate(IReadOnlyList<BlueprintMember> members)
    {
        if (members.Count == 0) throw new ArgumentException("Add at least one network to the blueprint.");
        foreach (var m in members)
        {
            if (string.IsNullOrWhiteSpace(m.ScopeId) || string.IsNullOrWhiteSpace(m.Region) || string.IsNullOrWhiteSpace(m.NetworkId))
                throw new ArgumentException("Each network needs a scope, region and network id.");
            if (!SupportedProviders.Contains(m.Provider))
                throw new ArgumentException($"Provider '{m.Provider}' is not supported yet — this version supports aws.");
            if (m.Provider == "aws" && !m.NetworkId.StartsWith("vpc-", StringComparison.Ordinal))
                throw new ArgumentException($"'{m.NetworkId}' is not a VPC id.");
        }
        // The same network under two scopes (both scopes reach the account) is still one network.
        var dup = members.GroupBy(NetworkKey).FirstOrDefault(g => g.Count() > 1);
        if (dup != null)
            throw new ArgumentException($"{dup.First().NetworkId} in {dup.First().Region} is listed twice.");
    }

    public static List<string> DerivedScopeIds(IEnumerable<BlueprintMember> members) =>
        members.Select(m => m.ScopeId).Distinct(StringComparer.Ordinal).OrderBy(s => s, StringComparer.Ordinal).ToList();

    public static string MembersHash(IEnumerable<BlueprintMember> members)
    {
        var text = string.Join("\n", members.Select(Key).OrderBy(k => k, StringComparer.Ordinal));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant()[..16];
    }

    private static string NetworkKey(BlueprintMember m) => $"{m.Provider}|{m.Region}|{m.NetworkId}";

    private static string Key(BlueprintMember m) => $"{m.Provider}|{m.ScopeId}|{m.Region}|{m.NetworkId}";
}
