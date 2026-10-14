using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace Duplo.Extension.Cloudflare.Cf;

/// <summary>A Cloudflare API failure. The message carries the status and Cloudflare's error text, never the token.</summary>
public sealed class CloudflareApiException : Exception
{
    public HttpStatusCode? Status { get; }
    public CloudflareApiException(string message, HttpStatusCode? status = null) : base(message) => Status = status;
}

/// <summary>Read-only surface the worker needs — an interface so the worker can be tested with a fake.</summary>
public interface ICloudflareClient
{
    Task<CfTokenVerify> VerifyTokenAsync(CancellationToken ct);
    Task<List<CfScript>> ListScriptsAsync(CancellationToken ct);
    Task<List<CfDeployment>> ListDeploymentsAsync(string scriptName, CancellationToken ct);
}

/// <summary>
/// Thin typed wrapper over the v4 REST API: bearer auth per request, envelope unwrapping, page-based pagination,
/// and one Retry-After-honouring retry on 429. The <see cref="HttpClient"/> is supplied by the caller (the host's
/// IHttpClientFactory in production, a fake handler in tests).
/// </summary>
public sealed class CloudflareClient : ICloudflareClient
{
    private const int MaxPages = 20;
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    private readonly HttpClient _http;
    private readonly CloudflareConnection _conn;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly Func<DateTime> _clock;

    public CloudflareClient(HttpClient http, CloudflareConnection conn,
        Func<TimeSpan, CancellationToken, Task>? delay = null, Func<DateTime>? clock = null)
    {
        _http = http;
        _conn = conn;
        _delay = delay ?? Task.Delay;
        _clock = clock ?? (() => DateTime.UtcNow);
    }

    private string Account => Uri.EscapeDataString(_conn.AccountId);

    /// <summary>
    /// Verifies the token. Account-owned tokens (recommended) verify at the account endpoint; user tokens
    /// (My Profile → API Tokens) are rejected there and verify at <c>/user/tokens/verify</c> — so fall back.
    /// </summary>
    public async Task<CfTokenVerify> VerifyTokenAsync(CancellationToken ct)
    {
        CfEnvelope<CfTokenVerify> env;
        try
        {
            env = await GetAsync<CfTokenVerify>($"accounts/{Account}/tokens/verify", ct);
        }
        catch (CloudflareApiException ex) when (ex.Status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden
                                                    or HttpStatusCode.BadRequest or HttpStatusCode.NotFound)
        {
            env = await GetAsync<CfTokenVerify>("user/tokens/verify", ct);
        }
        return env.Result ?? throw new CloudflareApiException("Cloudflare returned an empty token-verify result.");
    }

    public async Task<List<CfScript>> ListScriptsAsync(CancellationToken ct)
    {
        var all = new List<CfScript>();
        for (var page = 1; page <= MaxPages; page++)
        {
            // The scripts endpoint historically returns everything in one page; honour result_info if it pages.
            var env = await GetAsync<List<CfScript>>($"accounts/{Account}/workers/scripts?page={page}&per_page=100", ct);
            all.AddRange(env.Result ?? new List<CfScript>());
            var info = env.ResultInfo;
            if (info?.TotalPages is not int total || page >= total) break;
        }
        return all;
    }

    public async Task<List<CfDeployment>> ListDeploymentsAsync(string scriptName, CancellationToken ct)
    {
        var env = await GetAsync<CfDeploymentList>(
            $"accounts/{Account}/workers/scripts/{Uri.EscapeDataString(scriptName)}/deployments", ct);
        return env.Result?.Deployments ?? new List<CfDeployment>();
    }

    private async Task<CfEnvelope<T>> GetAsync<T>(string path, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, $"{_conn.BaseUrl}/{path}");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _conn.ApiToken);
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

            using var resp = await _http.SendAsync(req, ct);
            if (resp.StatusCode == HttpStatusCode.TooManyRequests && attempt == 0)
            {
                var retryAfter = resp.Headers.TryGetValues("Retry-After", out var vals) ? vals.FirstOrDefault() : null;
                await _delay(RateLimit.DelayFor(retryAfter, _clock()), ct);
                continue;
            }

            var body = await resp.Content.ReadAsStringAsync(ct);
            CfEnvelope<T>? env = null;
            try { env = JsonSerializer.Deserialize<CfEnvelope<T>>(body, Json); }
            catch (JsonException) { /* non-JSON error page — reported below */ }

            if (resp.IsSuccessStatusCode && env is { Success: true })
                return env;

            var detail = env?.Errors is { Count: > 0 } errs
                ? string.Join("; ", errs.Select(e => $"{e.Code}: {e.Message}"))
                : Truncate(body);
            throw new CloudflareApiException(
                $"Cloudflare GET /{StripQuery(path)} failed ({(int)resp.StatusCode} {resp.StatusCode}): {detail}",
                resp.StatusCode);
        }
    }

    private static string StripQuery(string path) => path.Split('?')[0];
    private static string Truncate(string s) => s.Length <= 200 ? s : s[..200] + "…";
}
