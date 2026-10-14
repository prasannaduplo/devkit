using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.DataManagement.Services;
using Duplo.Ai.Model;
using Duplo.Ai.Model.Attributes;
using Duplo.Ai.Model.Interfaces;
using Duplo.Ai.Model.Resource;
using Duplo.Ai.Studio.Extensibility.Infra;
using Duplo.Extension.Cloudflare.Cf;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.Cloudflare;

// WORKER resource: watches one Cloudflare account's Workers (inventory + deployments) on a fixed cadence.
// No skill mapping → NoSkillsFallbackMode = Worker, and CloudflareWatchWorker owns create/update/delete.
// Read-only against Cloudflare; credentials come from an `other`-category scope (accountId + apiToken).
// See README.md for the scope convention and EXTENSION_BACKLOG.md #58 for the roadmap (v2 governed deploy).

[BsonIgnoreExtraElements]
public class CloudflareWatchSpec : BaseSpec
{
    /// <summary>Optional comma-separated globs (e.g. <c>api-*,web-?</c>); empty watches every Worker.</summary>
    public string? ScriptNameFilter { get; set; }

    /// <summary>How many change events to keep (newest first).</summary>
    public int HistoryLimit { get; set; } = CloudflareWatchService.DefaultHistoryLimit;
}

[BsonIgnoreExtraElements]
public class CloudflareWatchResult : BaseResult
{
    public string? AccountId { get; set; }
    public string? TokenStatus { get; set; }
    public DateTime? TokenExpiresOn { get; set; }
    public DateTime? TokenNotBefore { get; set; }
    /// <summary>First successful scan; Workers that existed before it are not reported as changes.</summary>
    public DateTime? BaselineAt { get; set; }
    /// <summary>The filter the current state was built with — a change re-baselines instead of reporting deletions.</summary>
    public string? AppliedFilter { get; set; }
    public DateTime? LastScannedAt { get; set; }
    public string? LastError { get; set; }
    public int ScriptCount { get; set; }
    /// <summary>Scripts whose deployments are still to be fetched (fetch cap hit this tick).</summary>
    public int PendingScripts { get; set; }
    public List<WorkerScriptState> Scripts { get; set; } = new();
    public List<WorkerEvent> Events { get; set; } = new();
    public WorkerEventCounts EventCounts { get; set; } = new();
}

[BsonCollection("extension_cloudflarewatch")]
[BsonIgnoreExtraElements]
public class CloudflareWatch : ResourceBase<CloudflareWatchSpec, CloudflareWatchResult>
{
    public override string GetTicketOriginType() => "CloudflareWatch";
    public override string GetTicketOriginSubType() => "cloudflare-watch";
}

public class CloudflareWatchHooks : DefaultEntityHooks<CloudflareWatch>
{
}

public class CloudflareWatchService : ResourceServiceBase<CloudflareWatch, CloudflareWatchSpec, CloudflareWatchResult>
{
    public const int DefaultHistoryLimit = 200;
    public const int MaxHistoryLimit = 1000;

    private readonly IScopeCredentials _scopeCredentials;

    public CloudflareWatchService(
        IRepository<CloudflareWatch> repository,
        ILogger<CloudflareWatchService> logger,
        IServiceScopeFactory scopeFactory,
        IHttpContextAccessor httpContextAccessor,
        IScopeCredentials scopeCredentials)
        : base(repository, logger, scopeFactory, httpContextAccessor)
    {
        _scopeCredentials = scopeCredentials;
    }

    protected override ProvisioningMode NoSkillsFallbackMode => ProvisioningMode.Worker;

    // Fail the save (HTTP 400) with a readable message when the scope is missing or lacks the keys; the token
    // itself is checked against Cloudflare by the worker, which can surface Cloudflare's own error.
    protected override async Task ValidateSpecAsync(
        CloudflareWatchSpec spec,
        bool isUpdate,
        CloudflareWatchSpec? existingSpec,
        CancellationToken cancellationToken = default)
    {
        if (spec.HistoryLimit <= 0) spec.HistoryLimit = DefaultHistoryLimit;
        if (spec.HistoryLimit > MaxHistoryLimit)
            throw new ArgumentException($"History limit must be at most {MaxHistoryLimit}.");
        spec.ScriptNameFilter = string.IsNullOrWhiteSpace(spec.ScriptNameFilter) ? null : spec.ScriptNameFilter.Trim();

        var scope = await _scopeCredentials.RequireOfCategoryAsync(
            spec.ScopeIds ?? Enumerable.Empty<string>(),
            ProviderCategory.other,
            "Attach a Cloudflare scope (provider type Other, credential keys accountId + apiToken).",
            cancellationToken);

        var (_, error) = CloudflareCredentials.From(scope.Data, scope.Provider.AccountId, scope.Scope?.Name);
        if (error != null)
            throw new ArgumentException(error);
    }
}
