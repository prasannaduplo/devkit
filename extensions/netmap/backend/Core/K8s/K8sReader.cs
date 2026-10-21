using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Duplo.Extension.NetMap.Core.K8s;

/// <summary>A Kubernetes API answer the reader cannot use: 401 (identity not mapped), 403 (RBAC), other status.</summary>
public sealed class K8sHttpException : Exception
{
    public K8sHttpException(int status, string path) : base($"HTTP {status} from GET {path}") { Status = status; Path = path; }
    public int Status { get; }
    public string Path { get; }
}

/// <summary>Read-only cluster-wide LIST calls (GET only) against one EKS API server, paginated with
/// <c>limit</c>/<c>continue</c>. Reads namespaces, pods, services, ingresses, networkpolicies and nodes -- never
/// Secrets or ConfigMaps. Every item is projected through <see cref="K8sParse"/> as soon as its page arrives, so
/// nothing beyond the safe fields is kept.</summary>
public sealed class K8sReader
{
    public const int PageSize = 500;
    public const int MaxPods = 3000;
    public const int MaxOther = 5000;
    public static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(15);

    /// <summary>The only paths this reader ever requests.</summary>
    public static readonly IReadOnlyList<string> Paths = new[]
    {
        "/api/v1/namespaces", "/api/v1/pods", "/api/v1/services",
        "/apis/networking.k8s.io/v1/ingresses", "/apis/networking.k8s.io/v1/networkpolicies", "/api/v1/nodes",
    };

    private readonly HttpClient _http;

    public K8sReader(HttpClient http) => _http = http;

    /// <summary>An HttpClient bound to the API server, trusting only the cluster CA, with the bearer token. The token is
    /// a credential: it lives only in this client's default headers and is never logged.</summary>
    public static HttpClient Client(HttpMessageHandler handler, Uri endpoint, string token)
    {
        var http = new HttpClient(handler, disposeHandler: true) { BaseAddress = endpoint, Timeout = CallTimeout };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return http;
    }

    /// <summary>Namespaces, pods and services are required (401/403 propagate as K8sHttpException); ingresses,
    /// network policies and nodes are optional and degrade to empty with a warning.</summary>
    public async Task<K8sObjects> ReadAsync(CancellationToken ct)
    {
        var o = new K8sObjects();
        o.Namespaces.AddRange((await ListAsync(Paths[0], MaxOther, ct)).Items.Select(K8sParse.Namespace));
        var pods = await ListAsync(Paths[1], MaxPods, ct);
        o.Pods.AddRange(pods.Items.Select(K8sParse.Pod));
        o.PodsTruncated = pods.Truncated;
        o.Services.AddRange((await ListAsync(Paths[2], MaxOther, ct)).Items.Select(K8sParse.Service));
        o.Ingresses.AddRange(await OptionalAsync(Paths[3], K8sParse.Ingress, o.Warnings, "ingresses", ct));
        o.NetworkPolicies.AddRange(await OptionalAsync(Paths[4], K8sParse.NetworkPolicy, o.Warnings, "networkpolicies", ct));
        o.Nodes.AddRange(await OptionalAsync(Paths[5], K8sParse.Node, o.Warnings, "nodes", ct));
        o.ExcludeSystemNamespaces();
        return o;
    }

    private async Task<List<T>> OptionalAsync<T>(string path, Func<JsonNode, T> parse, List<string> warnings, string what, CancellationToken ct)
    {
        try { return (await ListAsync(path, MaxOther, ct)).Items.Select(parse).ToList(); }
        catch (K8sHttpException ex) when (ex.Status is 403 or 404)
        {
            warnings.Add($"{what} not readable (HTTP {ex.Status})");
            return new List<T>();
        }
    }

    public async Task<(List<JsonNode> Items, bool Truncated)> ListAsync(string path, int max, CancellationToken ct)
    {
        var items = new List<JsonNode>();
        string? cont = null;
        do
        {
            var url = $"{path}?limit={PageSize}" + (cont == null ? "" : "&continue=" + Uri.EscapeDataString(cont));
            using var resp = await _http.GetAsync(url, ct);
            if (!resp.IsSuccessStatusCode) throw new K8sHttpException((int)resp.StatusCode, path);
            var body = JsonNode.Parse(await resp.Content.ReadAsStringAsync(ct)) ?? throw new JsonException("empty list body");
            foreach (var i in body["items"] as JsonArray ?? new JsonArray())
                if (i != null) items.Add(i);
            cont = (body["metadata"]?["continue"] as JsonValue)?.GetValue<string>();
            if (string.IsNullOrEmpty(cont)) cont = null;
            if (items.Count >= max) return (items.Take(max).ToList(), cont != null || items.Count > max);
        } while (cont != null);
        return (items, false);
    }

    /// <summary>Why a cluster could not be read, as the missing permission / access the operator must grant.</summary>
    public static string DenialText(Exception ex, string? callerRole, bool? publicAccess)
    {
        var who = callerRole ?? "the scope's IAM role";
        return ex switch
        {
            K8sHttpException { Status: (int)HttpStatusCode.Unauthorized } => $"EKS access entry for {who} (AmazonEKSViewPolicy)",
            K8sHttpException { Status: (int)HttpStatusCode.Forbidden } => $"Kubernetes read access for {who} (associate AmazonEKSViewPolicy or bind the view ClusterRole)",
            _ => publicAccess == false
                ? "network path to the private EKS API endpoint (endpointPublicAccess=false)"
                : "network path to the EKS API endpoint (check publicAccessCidrs)",
        };
    }

    /// <summary>True for failures that mean "this identity cannot read the cluster" rather than a bug or a transient error.</summary>
    public static bool IsAccessFailure(Exception ex) =>
        ex is K8sHttpException { Status: 401 or 403 } or HttpRequestException or TaskCanceledException or TimeoutException;
}
