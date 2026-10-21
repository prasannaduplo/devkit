using System.Net;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Amazon.EKS;
using Amazon.EKS.Model;
using Amazon.Runtime;
using Amazon.SecurityToken;
using Amazon.SecurityToken.Model;

namespace Duplo.Extension.NetMap.Core.K8s;

/// <summary>One EKS cluster's answer to "can this scope's AWS identity read Kubernetes here?" (v2b spike).
/// Never carries the bearer token or any credential.</summary>
public sealed class K8sProbeResult
{
    public string Cluster { get; set; } = "";
    public string Region { get; set; } = "";
    public string? Version { get; set; }
    public string? Status { get; set; }
    /// <summary>API server host only (no scheme or path).</summary>
    public string? Endpoint { get; set; }
    public bool? EndpointPublicAccess { get; set; }
    public bool? EndpointPrivateAccess { get; set; }
    public List<string> PublicAccessCidrs { get; set; } = new();
    /// <summary>API | API_AND_CONFIG_MAP | CONFIG_MAP (EKS AccessConfig).</summary>
    public string? AuthenticationMode { get; set; }
    /// <summary>sts:GetCallerIdentity ARN, assumed-role session name replaced by "…".</summary>
    public string? CallerArn { get; set; }
    public bool ApiReachable { get; set; }
    public string? ApiVersion { get; set; }
    public bool? CanListPods { get; set; }
    public bool? CanListServices { get; set; }
    public bool? CanListNetworkPolicies { get; set; }
    public int? HttpStatus { get; set; }
    public string Message { get; set; } = "";
}

/// <summary>Read-only EKS / Kubernetes reachability + authorization probe: eks:ListClusters, eks:DescribeCluster,
/// sts:GetCallerIdentity, then per cluster GET /version and three SelfSubjectAccessReviews (list pods, services,
/// networkpolicies cluster-wide) with an EKS bearer token. TLS is validated against the cluster's own CA only.</summary>
public sealed class EksProbe
{
    public const int MaxClusters = 20;
    public const int Parallelism = 4;
    public static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(6);

    private readonly EksToken _token;
    private readonly Func<X509Certificate2, HttpMessageHandler> _handlerFactory;

    /// <param name="handlerFactory">Builds the HTTP handler for a cluster CA (tests substitute a fake).</param>
    public EksProbe(EksToken? token = null, Func<X509Certificate2, HttpMessageHandler>? handlerFactory = null)
    {
        _token = token ?? new EksToken();
        _handlerFactory = handlerFactory ?? ClusterCa.Handler;
    }

    public async Task<List<K8sProbeResult>> ProbeAsync(IAmazonEKS eks, IAmazonSecurityTokenService sts, AWSCredentials credentials,
        string region, CancellationToken ct)
    {
        var names = new List<string>();
        await foreach (var name in eks.Paginators.ListClusters(new ListClustersRequest()).Clusters.WithCancellation(ct))
        {
            names.Add(name);
            if (names.Count >= MaxClusters) break;
        }
        if (names.Count == 0) return new List<K8sProbeResult>();

        string? callerArn = null;
        try { callerArn = RedactCallerArn((await sts.GetCallerIdentityAsync(new GetCallerIdentityRequest(), ct)).Arn); }
        catch (AmazonServiceException) { /* reported per cluster as a null callerArn */ }

        var keys = await credentials.GetCredentialsAsync();
        using var gate = new SemaphoreSlim(Parallelism);
        var tasks = names.Select(async name =>
        {
            await gate.WaitAsync(ct);
            try { return await ProbeClusterAsync(eks, name, region, callerArn, keys, ct); }
            finally { gate.Release(); }
        });
        return (await Task.WhenAll(tasks)).OrderBy(r => r.Cluster, StringComparer.Ordinal).ToList();
    }

    private async Task<K8sProbeResult> ProbeClusterAsync(IAmazonEKS eks, string name, string region, string? callerArn,
        ImmutableCredentials keys, CancellationToken ct)
    {
        var r = new K8sProbeResult { Cluster = name, Region = region, CallerArn = callerArn };
        Cluster c;
        try { c = (await eks.DescribeClusterAsync(new DescribeClusterRequest { Name = name }, ct)).Cluster; }
        catch (AmazonServiceException ex)
        {
            r.Message = $"eks:DescribeCluster failed ({ex.ErrorCode ?? ex.StatusCode.ToString()}); API not probed.";
            return r;
        }

        r.Version = c.Version;
        r.Status = c.Status?.Value;
        r.EndpointPublicAccess = c.ResourcesVpcConfig?.EndpointPublicAccess;
        r.EndpointPrivateAccess = c.ResourcesVpcConfig?.EndpointPrivateAccess;
        r.PublicAccessCidrs = c.ResourcesVpcConfig?.PublicAccessCidrs ?? new List<string>();
        r.AuthenticationMode = c.AccessConfig?.AuthenticationMode?.Value;
        Uri? endpoint = Uri.TryCreate(c.Endpoint, UriKind.Absolute, out var u) ? u : null;
        r.Endpoint = endpoint?.Host;

        if (!string.Equals(r.Status, "ACTIVE", StringComparison.Ordinal))
        {
            r.Message = $"Cluster status is {r.Status ?? "unknown"}; API not probed.";
            return r;
        }
        if (endpoint == null || string.IsNullOrEmpty(c.CertificateAuthority?.Data))
        {
            r.Message = "Cluster has no API endpoint or CA in DescribeCluster; API not probed.";
            return r;
        }

        X509Certificate2 ca;
        try { ca = ClusterCa.FromBase64Pem(c.CertificateAuthority.Data); }
        catch (Exception ex) when (ex is FormatException or CryptographicException or ArgumentException)
        {
            r.Message = "Could not parse the cluster CA (certificateAuthority.data); API not probed.";
            return r;
        }

        using (ca)
        {
            var token = _token.Create(name, region, keys.AccessKey, keys.SecretKey, keys.Token);
            await ProbeApiAsync(r, endpoint, ca, token, ct);
        }
        return r;
    }

    /// <summary>GET /version, then the three SelfSubjectAccessReviews. Fills reachability, permissions, httpStatus and message.</summary>
    public async Task ProbeApiAsync(K8sProbeResult r, Uri endpoint, X509Certificate2 ca, string token, CancellationToken ct)
    {
        using var http = new HttpClient(_handlerFactory(ca), disposeHandler: true) { BaseAddress = endpoint, Timeout = CallTimeout };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        try
        {
            using (var v = await http.GetAsync("/version", ct))
            {
                r.ApiReachable = true;
                r.HttpStatus = (int)v.StatusCode;
                if (v.StatusCode == HttpStatusCode.Unauthorized) { r.Message = Messages.Unauthorized(r.AuthenticationMode); return; }
                if (v.IsSuccessStatusCode)
                    r.ApiVersion = JsonNode.Parse(await v.Content.ReadAsStringAsync(ct))?["gitVersion"]?.GetValue<string>();
            }

            r.CanListPods = await CanListAsync(http, r, "", "pods", ct);
            r.CanListServices = await CanListAsync(http, r, "", "services", ct);
            r.CanListNetworkPolicies = await CanListAsync(http, r, "networking.k8s.io", "networkpolicies", ct);
            r.Message = Messages.Summary(r);
        }
        catch (HttpFailure f)
        {
            r.HttpStatus = f.Status;
            r.Message = f.Status switch
            {
                401 => Messages.Unauthorized(r.AuthenticationMode),
                403 => Messages.Forbidden,
                _ => $"Unexpected HTTP {f.Status} from the API server ({f.Call}).",
            };
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            r.Message = Messages.Timeout(r.ApiReachable, r.EndpointPublicAccess);
        }
        catch (HttpRequestException ex)
        {
            r.Message = Messages.RequestFailed(ex, r.EndpointPublicAccess);
        }
        catch (JsonException)
        {
            r.Message = "The API server returned a body that is not the expected JSON.";
        }
    }

    private static async Task<bool?> CanListAsync(HttpClient http, K8sProbeResult r, string group, string resource, CancellationToken ct)
    {
        var review = new JsonObject
        {
            ["apiVersion"] = "authorization.k8s.io/v1",
            ["kind"] = "SelfSubjectAccessReview",
            ["spec"] = new JsonObject
            {
                ["resourceAttributes"] = new JsonObject { ["verb"] = "list", ["group"] = group, ["resource"] = resource },
            },
        };
        using var content = new StringContent(review.ToJsonString(), Encoding.UTF8, "application/json");
        using var resp = await http.PostAsync("/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", content, ct);
        r.HttpStatus = (int)resp.StatusCode;
        if (!resp.IsSuccessStatusCode) throw new HttpFailure((int)resp.StatusCode, $"SelfSubjectAccessReview list {resource}");
        var body = JsonNode.Parse(await resp.Content.ReadAsStringAsync(ct));
        return body?["status"]?["allowed"]?.GetValue<bool>() ?? false;
    }

    /// <summary>"arn:aws:sts::123:assumed-role/Role/session" → "arn:aws:sts::123:assumed-role/Role/…"; other ARNs unchanged.</summary>
    public static string? RedactCallerArn(string? arn) =>
        arn == null ? null : Regex.Replace(arn, @"^(arn:[^:]+:sts::[^:]*:assumed-role/[^/]+)/.+$", "$1/…");

    private sealed class HttpFailure : Exception
    {
        public HttpFailure(int status, string call) : base($"HTTP {status} from {call}") { Status = status; Call = call; }
        public int Status { get; }
        public string Call { get; }
    }

    internal static class Messages
    {
        public static string Unauthorized(string? authMode) =>
            "Unauthorized (401): the cluster does not recognise this AWS identity. Map callerArn's IAM role: " +
            (authMode switch
            {
                "CONFIG_MAP" => "add it to the aws-auth ConfigMap (this cluster's authenticationMode is CONFIG_MAP, so access entries are not available).",
                "API" => "create an EKS access entry for it (this cluster's authenticationMode is API).",
                _ => "create an EKS access entry for it, or add it to the aws-auth ConfigMap.",
            });

        public const string Forbidden =
            "Forbidden (403): the identity is mapped but lacks the RBAC permission for this request; associate a read-only " +
            "access policy (AmazonEKSViewPolicy) or bind the view ClusterRole.";

        public static string Timeout(bool apiReachable, bool? publicAccess) => apiReachable
            ? $"The API server answered /version but a later call timed out after {CallTimeout.TotalSeconds:0} s."
            : $"Timed out after {CallTimeout.TotalSeconds:0} s reaching the API server: " + (publicAccess == false
                ? "the endpoint is private-only (endpointPublicAccess=false) and the helpdesk backend has no network path to the VPC."
                : "likely publicAccessCidrs excludes the helpdesk backend's egress IP, or the network path from the backend is blocked.");

        public static string RequestFailed(HttpRequestException ex, bool? publicAccess)
        {
            for (Exception? e = ex; e != null; e = e.InnerException)
            {
                if (e is AuthenticationException)
                    return "TLS handshake failed: the API server certificate did not validate against the cluster CA from DescribeCluster (or the host name did not match).";
                if (e is SocketException se)
                    return $"Could not connect to the API server ({se.SocketErrorCode}): " + (publicAccess == false
                        ? "the endpoint is private-only and resolves to VPC addresses the helpdesk backend cannot reach."
                        : "DNS or network path from the helpdesk backend failed.");
            }
            return $"Request to the API server failed: {ex.Message}";
        }

        public static string Summary(K8sProbeResult r)
        {
            var denied = new List<string>();
            if (r.CanListPods != true) denied.Add("pods");
            if (r.CanListServices != true) denied.Add("services");
            if (r.CanListNetworkPolicies != true) denied.Add("networkpolicies");
            return denied.Count == 0
                ? $"OK: API reachable{(r.ApiVersion is { } v ? $" ({v})" : "")}; the identity can list pods, services and networkpolicies cluster-wide."
                : $"Authenticated, but RBAC denies cluster-wide list on {string.Join(", ", denied)}; associate AmazonEKSViewPolicy " +
                  "(access entry) or bind the view ClusterRole.";
        }
    }
}

/// <summary>Trust exactly the cluster's CA for the API server's TLS certificate (never disables validation).</summary>
public static class ClusterCa
{
    /// <summary>certificateAuthority.data is base64 of a PEM certificate.</summary>
    public static X509Certificate2 FromBase64Pem(string data) =>
        X509Certificate2.CreateFromPem(Encoding.UTF8.GetString(Convert.FromBase64String(data)));

    public static HttpMessageHandler Handler(X509Certificate2 ca) => new HttpClientHandler
    {
        UseProxy = true,
        UseCookies = false,
        AllowAutoRedirect = false,
        ServerCertificateCustomValidationCallback = (_, cert, chain, errors) => Validate(ca, cert, chain, errors),
    };

    /// <summary>The server certificate must chain to <paramref name="ca"/> as the only trust root, and the platform
    /// must not report a missing certificate or a host-name mismatch. Revocation is not checked (EKS publishes none).</summary>
    public static bool Validate(X509Certificate2 ca, X509Certificate2? leaf, X509Chain? presented, SslPolicyErrors errors)
    {
        if (leaf == null) return false;
        if ((errors & (SslPolicyErrors.RemoteCertificateNotAvailable | SslPolicyErrors.RemoteCertificateNameMismatch)) != 0) return false;
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(ca);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        if (presented != null)
            foreach (var el in presented.ChainElements)
                if (!el.Certificate.RawData.AsSpan().SequenceEqual(leaf.RawData)) chain.ChainPolicy.ExtraStore.Add(el.Certificate);
        return chain.Build(leaf);
    }
}
