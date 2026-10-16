using System.Text.Json.Nodes;

namespace Duplo.Extension.NetMap.Core.Graph;

/// <summary>The single choke point every collector's raw document passes through before it is stored. VPN
/// pre-shared keys (CustomerGatewayConfiguration XML and TunnelOptions[].PreSharedKey) are the known AWS secrets in
/// the v1 collectors; the suffix rules are a safety net for future collectors. Extend the denylist whenever a new
/// collector is added.</summary>
public static class Sanitizer
{
    private static readonly HashSet<string> DeniedKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "CustomerGatewayConfiguration", "PreSharedKey", "SecretAccessKey", "SessionToken", "PrivateKey",
        "AuthKey", "SharedKey", "Password",
    };

    public static JsonObject Sanitize(JsonObject obj)
    {
        Walk(obj);
        return obj;
    }

    public static bool IsDenied(string key)
    {
        var k = new string(key.Where(char.IsLetterOrDigit).ToArray());
        return DeniedKeys.Contains(k)
            || k.EndsWith("Password", StringComparison.OrdinalIgnoreCase)
            || k.EndsWith("Secret", StringComparison.OrdinalIgnoreCase);
    }

    private static void Walk(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject o:
                foreach (var key in o.Select(p => p.Key).ToList())
                {
                    if (IsDenied(key)) o.Remove(key);
                    else Walk(o[key]);
                }
                break;
            case JsonArray a:
                foreach (var item in a) Walk(item);
                break;
        }
    }
}
