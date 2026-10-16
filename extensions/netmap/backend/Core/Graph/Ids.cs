using System.Security.Cryptography;
using System.Text;

namespace Duplo.Extension.NetMap.Core.Graph;

/// <summary>Canonical node identity: <c>provider:account:region:kind:nativeId</c>. Empty segments are "-". The
/// native id is the last segment and may itself contain ':' (ARNs, IPv6 CIDRs), so parsing splits into at most
/// five parts. AWS ids leave the account segment empty (see AwsIds): AWS resource ids are unique without it, and
/// a route in a spoke account that points at a shared TGW cannot know the TGW owner -- keeping the account out of
/// the id is what lets both sightings merge into one node.</summary>
public static class NodeId
{
    public static string For(string provider, string? account, string? region, string kind, string nativeId) =>
        $"{provider}:{Seg(account)}:{Seg(region)}:{kind}:{nativeId}";

    public static (string Provider, string? Account, string? Region, string Kind, string NativeId) Parse(string id)
    {
        var p = id.Split(':', 5);
        if (p.Length < 5) throw new FormatException($"Not a canonical node id: '{id}'.");
        return (p[0], Unseg(p[1]), Unseg(p[2]), p[3], p[4]);
    }

    public static bool TryParse(string id, out (string Provider, string? Account, string? Region, string Kind, string NativeId) parts)
    {
        try { parts = Parse(id); return true; }
        catch (FormatException) { parts = default; return false; }
    }

    /// <summary>Synthetic container node for a cloud account.</summary>
    public static string Account(string provider, string? account) =>
        For(provider, null, "global", NodeKinds.Account, string.IsNullOrEmpty(account) ? "unknown" : account);

    public static readonly string Internet = For("net", null, "global", NodeKinds.External, "internet");

    public static string Cidr(string cidr) => For("net", null, "global", NodeKinds.CidrBlock, cidr);

    private static string Seg(string? s) => string.IsNullOrEmpty(s) ? "-" : s;
    private static string? Unseg(string s) => s == "-" ? null : s;
}

/// <summary>Deterministic edge id: the same relationship in two snapshots has the same id, which is what makes
/// snapshot diffs (v4) cheap.</summary>
public static class EdgeId
{
    public static string For(string from, string kind, string to, string qualifier = "")
    {
        var hash = SHA1.HashData(Encoding.UTF8.GetBytes($"{from}|{kind}|{to}|{qualifier}"));
        return Convert.ToHexString(hash, 0, 10).ToLowerInvariant();
    }
}
