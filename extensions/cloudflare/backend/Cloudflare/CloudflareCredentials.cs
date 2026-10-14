namespace Duplo.Extension.Cloudflare.Cf;

/// <summary>Connection details read from an <c>other</c>-category Cloudflare scope.</summary>
public sealed record CloudflareConnection(string BaseUrl, string AccountId, string ApiToken);

/// <summary>
/// Maps a scope's decrypted credential data onto a <see cref="CloudflareConnection"/>. Key lookup ignores case,
/// '_', '-' and spaces (same idea as prd-mgmt-extension's ScopeKeys.Find) so <c>apiToken</c>, <c>api_token</c> and
/// <c>API-TOKEN</c> all match. The base URL comes from the provider's AccountId when it is a URL (the documented
/// convention for <c>other</c> providers), else the public v4 endpoint.
/// </summary>
public static class CloudflareCredentials
{
    public const string DefaultBaseUrl = "https://api.cloudflare.com/client/v4";

    private static readonly string[] AccountKeys = { "accountId", "cfAccountId", "account" };
    private static readonly string[] TokenKeys = { "apiToken", "token", "cfApiToken", "bearerToken" };

    /// <summary>Returns the connection, or an error message naming the missing key (never a value).</summary>
    public static (CloudflareConnection? Connection, string? Error) From(
        IReadOnlyDictionary<string, string>? data, string? providerAccountId, string? scopeName = null)
    {
        var label = string.IsNullOrWhiteSpace(scopeName) ? "The Cloudflare scope" : $"Scope '{scopeName}'";
        var account = Find(data, AccountKeys);
        if (account == null)
            return (null, $"{label} has no accountId credential key (the Cloudflare account ID).");
        var token = Find(data, TokenKeys);
        if (token == null)
            return (null, $"{label} has no apiToken credential key (an account-owned Cloudflare API token).");

        var baseUrl = providerAccountId?.Trim();
        if (string.IsNullOrEmpty(baseUrl) || !Uri.TryCreate(baseUrl, UriKind.Absolute, out var u)
            || (u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeHttp))
            baseUrl = DefaultBaseUrl;

        return (new CloudflareConnection(baseUrl.TrimEnd('/'), account, token), null);
    }

    public static string? Find(IReadOnlyDictionary<string, string>? data, params string[] names)
    {
        if (data == null) return null;
        foreach (var name in names)
        {
            var want = Canonical(name);
            foreach (var (k, v) in data)
                if (Canonical(k) == want && !string.IsNullOrWhiteSpace(v))
                    return v.Trim();
        }
        return null;
    }

    private static string Canonical(string s) =>
        new(s.Where(c => c != '_' && c != '-' && c != ' ').Select(char.ToLowerInvariant).ToArray());
}
