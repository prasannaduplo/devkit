using Duplo.Ai.DataManagement.Services.Workers;
using Duplo.Ai.Model;
using Duplo.Ai.Studio.Extensibility.Infra;
using Duplo.Extension.Cloudflare.Cf;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Duplo.Extension.Cloudflare;

/// <summary>
/// Background worker for <see cref="CloudflareWatch"/> (pattern: duploai-extension-pull-request-review's
/// PullRequestRepositoryWorker).
///   * <see cref="ApplyAsync"/> (create / spec edit) verifies the token — an inactive token fails the row — then
///     scans; the first successful scan records the baseline (no events for Workers that already existed).
///   * <see cref="VerifyDriftAsync"/> runs every <see cref="DriftCadence"/> on Complete rows and rescans. Scan
///     errors land on <c>Result.LastError</c> and never fail the row, so a Cloudflare blip doesn't flap status.
///   * Deletion touches nothing in Cloudflare — the watch is read-only.
/// Each scan is one scripts list plus at most <see cref="MaxDeploymentFetchesPerTick"/> deployments calls, so a
/// tick stays well inside the platform's ~97s worker budget; changed scripts beyond the cap roll to the next tick.
/// </summary>
public class CloudflareWatchWorker : ResourceWorkerBase<CloudflareWatch, CloudflareWatchSpec, CloudflareWatchResult>
{
    public const int MaxDeploymentFetchesPerTick = 50;
    private const string HttpClientName = "duplo-extension-cloudflare";

    public CloudflareWatchWorker(IServiceScopeFactory scopeFactory, ILogger<CloudflareWatchWorker> logger, IConfiguration? config = null)
        : base(scopeFactory, logger, config)
    {
    }

    protected override TimeSpan DriftCadence => TimeSpan.FromMinutes(5);

    protected override async Task ApplyAsync(CloudflareWatch e, IServiceProvider scope, CancellationToken ct)
    {
        e.Result ??= new CloudflareWatchResult();
        var (conn, client) = await CreateClientAsync(e, scope, ct);

        var verify = await client.VerifyTokenAsync(ct);
        e.Result.AccountId = conn.AccountId;
        e.Result.TokenStatus = verify.Status;
        e.Result.TokenExpiresOn = verify.ExpiresOn;
        e.Result.TokenNotBefore = verify.NotBefore;
        if (verify.UnusableReason(DateTime.UtcNow) is { } reason)
            throw new InvalidOperationException(reason);

        await ScanAsync(e, client, scope, ct);
    }

    protected override async Task VerifyDriftAsync(CloudflareWatch e, IServiceProvider scope, CancellationToken ct)
    {
        try
        {
            var (_, client) = await CreateClientAsync(e, scope, ct);
            await ScanAsync(e, client, scope, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            e.Result ??= new CloudflareWatchResult();
            e.Result.LastError = ex.Message;
            Logger.LogWarning("Cloudflare scan failed for {Id}: {Error}", e.Id, ex.Message);
            await SaveProgressAsync(scope, e, $"Scan failed: {ex.Message}", ct);
        }
    }

    // Read-only watch: nothing to remove in Cloudflare.
    protected override Task DeleteSubResourcesAsync(CloudflareWatch e, IServiceProvider scope, CancellationToken ct)
        => Task.CompletedTask;

    protected override Task<bool> WaitForDeletionAsync(CloudflareWatch e, IServiceProvider scope, CancellationToken ct)
        => Task.FromResult(true);

    private async Task ScanAsync(CloudflareWatch e, ICloudflareClient client, IServiceProvider scope, CancellationToken ct)
    {
        var r = e.Result ??= new CloudflareWatchResult();
        var spec = e.Spec ?? new CloudflareWatchSpec();
        var now = DateTime.UtcNow;

        // First scan, or the filter changed: rebuild state without reporting the difference as adds/deletes.
        var baseline = r.BaselineAt == null || !string.Equals(r.AppliedFilter, spec.ScriptNameFilter, StringComparison.Ordinal);
        var previous = baseline ? null : r.Scripts;

        var current = WorkerDiff.Filter(await client.ListScriptsAsync(ct), spec.ScriptNameFilter);
        var need = WorkerDiff.NeedingDeployments(previous, current, MaxDeploymentFetchesPerTick);

        var fetched = new Dictionary<string, List<CfDeployment>>(StringComparer.Ordinal);
        foreach (var name in need)
            fetched[name] = await client.ListDeploymentsAsync(name, ct);

        var outcome = WorkerDiff.Apply(previous, current, fetched, now, baseline);

        r.Scripts = outcome.Scripts;
        r.ScriptCount = outcome.Scripts.Count;
        r.PendingScripts = WorkerDiff.NeedingDeployments(outcome.Scripts, current, int.MaxValue).Count;
        r.Events = WorkerDiff.AppendHistory(r.Events, outcome.Events, spec.HistoryLimit);
        WorkerDiff.Count(r.EventCounts ??= new WorkerEventCounts(), outcome.Events);
        if (baseline)
        {
            r.BaselineAt = now;
            r.AppliedFilter = spec.ScriptNameFilter;
        }
        r.LastScannedAt = now;
        r.LastError = null;

        var summary = baseline
            ? $"Baseline recorded — watching {r.ScriptCount} Worker(s)"
            : outcome.Events.Count == 0
                ? $"No changes — {r.ScriptCount} Worker(s)"
                : $"{outcome.Events.Count} change(s): {string.Join(", ", outcome.Events.Take(3).Select(x => $"{x.Kind} {x.Script}"))}";
        await SaveProgressAsync(scope, e, summary, ct);
    }

    /// <summary>Resolves the scope and builds the client. Virtual so a test harness can substitute a fake.</summary>
    protected virtual async Task<(CloudflareConnection, ICloudflareClient)> CreateClientAsync(
        CloudflareWatch e, IServiceProvider scope, CancellationToken ct)
    {
        var creds = scope.GetRequiredService<IScopeCredentials>();
        var resolved = await creds.RequireOfCategoryAsync(
            e.Spec?.ScopeIds ?? Enumerable.Empty<string>(),
            ProviderCategory.other,
            "Attach a Cloudflare scope (provider type Other, credential keys accountId + apiToken).",
            ct);
        var (conn, error) = CloudflareCredentials.From(resolved.Data, resolved.Provider.AccountId, resolved.Scope?.Name);
        if (conn == null)
            throw new InvalidOperationException(error);

        var http = scope.GetRequiredService<IHttpClientFactory>().CreateClient(HttpClientName);
        http.Timeout = TimeSpan.FromSeconds(20);
        return (conn, new CloudflareClient(http, conn));
    }
}
