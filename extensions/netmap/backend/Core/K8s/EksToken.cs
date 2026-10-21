using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Duplo.Extension.NetMap.Core.K8s;

/// <summary>The EKS bearer token, the same one <c>aws eks get-token</c> / aws-iam-authenticator produce: a SigV4
/// query-string presigned <c>sts:GetCallerIdentity</c> GET URL whose signature also covers the
/// <c>x-k8s-aws-id: &lt;cluster&gt;</c> header, encoded as <c>"k8s-aws-v1." + base64url(url)</c> without padding.
/// The API server's authenticator replays the URL against STS (adding that header) to learn the caller's ARN.
/// Pure and clock-injectable so it can be checked against reference vectors. The token is a credential: never
/// log it or return it.</summary>
public sealed class EksToken
{
    public const string Prefix = "k8s-aws-v1.";
    public const string ClusterHeader = "x-k8s-aws-id";
    public const int ExpiresSeconds = 60;

    private readonly Func<DateTime> _utcNow;

    public EksToken(Func<DateTime>? utcNow = null) => _utcNow = utcNow ?? (() => DateTime.UtcNow);

    public string Create(string clusterName, string region, string accessKey, string secretKey, string? sessionToken) =>
        Prefix + Base64Url(PresignedUrl(clusterName, region, accessKey, secretKey, sessionToken));

    /// <summary>The presigned regional STS URL (query params in canonical order, X-Amz-Signature last).</summary>
    public string PresignedUrl(string clusterName, string region, string accessKey, string secretKey, string? sessionToken)
    {
        if (string.IsNullOrWhiteSpace(clusterName)) throw new ArgumentException("clusterName is required.");
        if (string.IsNullOrWhiteSpace(region)) throw new ArgumentException("region is required.");
        var host = StsHost(region);
        var query = new Dictionary<string, string>
        {
            ["Action"] = "GetCallerIdentity",
            ["Version"] = "2011-06-15",
        };
        if (!string.IsNullOrEmpty(sessionToken)) query["X-Amz-Security-Token"] = sessionToken;
        var headers = new Dictionary<string, string> { [ClusterHeader] = clusterName };
        return SigV4Presigner.Presign("GET", host, "/", query, headers, SigV4Presigner.EmptyPayloadHash,
            "sts", region, accessKey, secretKey, _utcNow(), ExpiresSeconds);
    }

    /// <summary>Regional STS endpoint (the authenticator accepts regional hosts); China regions use amazonaws.com.cn.</summary>
    public static string StsHost(string region) =>
        region.StartsWith("cn-", StringComparison.Ordinal) ? $"sts.{region}.amazonaws.com.cn" : $"sts.{region}.amazonaws.com";

    public static string Base64Url(string s) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(s)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

/// <summary>AWS Signature Version 4, query-string (presigned URL) form. Follows the spec: canonical request =
/// method, canonical URI, canonical query (every param except X-Amz-Signature, RFC 3986 encoded, sorted by encoded
/// name then value), canonical headers (lower-case names, trimmed values, sorted, each newline-terminated), signed
/// header list, payload hash; string to sign = algorithm, timestamp, credential scope, hex(sha256(canonical request));
/// key = HMAC chain "AWS4"+secret → date → region → service → "aws4_request".</summary>
public static class SigV4Presigner
{
    public const string Algorithm = "AWS4-HMAC-SHA256";
    public const string UnsignedPayload = "UNSIGNED-PAYLOAD";
    /// <summary>hex(sha256("")): non-S3 services sign the (empty) GET body.</summary>
    public const string EmptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    public static string Presign(string method, string host, string path, IReadOnlyDictionary<string, string> query,
        IReadOnlyDictionary<string, string> extraSignedHeaders, string payloadHash, string service, string region,
        string accessKey, string secretKey, DateTime utcNow, int expiresSeconds)
    {
        if (utcNow.Kind == DateTimeKind.Local) utcNow = utcNow.ToUniversalTime();
        var amzDate = utcNow.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture);
        var date = amzDate[..8];
        var scope = $"{date}/{region}/{service}/aws4_request";

        var headers = new SortedDictionary<string, string>(StringComparer.Ordinal) { ["host"] = host };
        foreach (var (k, v) in extraSignedHeaders) headers[k.ToLowerInvariant()] = v.Trim();
        var signedHeaders = string.Join(";", headers.Keys);

        var all = new Dictionary<string, string>(query)
        {
            ["X-Amz-Algorithm"] = Algorithm,
            ["X-Amz-Credential"] = $"{accessKey}/{scope}",
            ["X-Amz-Date"] = amzDate,
            ["X-Amz-Expires"] = expiresSeconds.ToString(CultureInfo.InvariantCulture),
            ["X-Amz-SignedHeaders"] = signedHeaders,
        };
        var canonicalQuery = CanonicalQuery(all);

        var canonicalRequest = string.Join("\n",
            method,
            CanonicalPath(path),
            canonicalQuery,
            string.Concat(headers.Select(h => $"{h.Key}:{h.Value}\n")),
            signedHeaders,
            payloadHash);
        var stringToSign = string.Join("\n", Algorithm, amzDate, scope, Hex(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalRequest))));

        var key = Hmac(Encoding.UTF8.GetBytes("AWS4" + secretKey), date);
        key = Hmac(key, region);
        key = Hmac(key, service);
        key = Hmac(key, "aws4_request");
        var signature = Hex(Hmac(key, stringToSign));

        return $"https://{host}{CanonicalPath(path)}?{canonicalQuery}&X-Amz-Signature={signature}";
    }

    public static string CanonicalQuery(IReadOnlyDictionary<string, string> query) => string.Join("&",
        query.Select(kv => (K: UriEncode(kv.Key), V: UriEncode(kv.Value)))
            .OrderBy(p => p.K, StringComparer.Ordinal).ThenBy(p => p.V, StringComparer.Ordinal)
            .Select(p => $"{p.K}={p.V}"));

    /// <summary>Each segment URI-encoded once, slashes kept (single-encoding is right for STS and S3 alike when the
    /// path holds only unreserved characters, as here).</summary>
    private static string CanonicalPath(string path) =>
        string.IsNullOrEmpty(path) ? "/" : string.Join("/", path.Split('/').Select(UriEncode));

    /// <summary>RFC 3986: unreserved A-Z a-z 0-9 - _ . ~ kept, everything else %XX (upper-case hex) over UTF-8.</summary>
    public static string UriEncode(string s)
    {
        var sb = new StringBuilder(s.Length * 3);
        foreach (var b in Encoding.UTF8.GetBytes(s))
        {
            var c = (char)b;
            if (c is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '-' or '_' or '.' or '~') sb.Append(c);
            else sb.Append('%').Append(b.ToString("X2", CultureInfo.InvariantCulture));
        }
        return sb.ToString();
    }

    private static byte[] Hmac(byte[] key, string data) => HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(data));

    private static string Hex(byte[] bytes) => Convert.ToHexString(bytes).ToLowerInvariant();
}
