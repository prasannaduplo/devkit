using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text.Json;
using Amazon.EC2;
using Amazon.EC2.Model;
using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.DataManagement.Services;
using Duplo.Ai.Model.Attributes;
using Duplo.Ai.Model.Interfaces;
using Duplo.Ai.Model.Resource;
using Duplo.Ai.Studio.Extensibility.Infra;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.NetworkStack;

// NetworkStack — the dev-kit's big worked sample: an AWS network stack (VPC + subnets + security group)
// provisioned by a LONG-RUNNING background terraform the skill launches detached and watches with a sleep
// loop (skills/provision-network-stack). Demonstrates, at teaching scale:
//   • action-driven on-demand runs (Plan/Apply buttons → TriggerActionAsync → the SAME long-lived ticket),
//   • run history + logs served from the ticket workdir via ITicketService (reference/05 §7),
//   • progressive Result.modules[] posts during a run,
//   • live-state enrichment on GET (EnrichResultAsync via IScopeClientFactory — reference/12),
//   • a custom tabbed Result view in the remote (reference/17) with an Ask AI tab (reference/16).

/// <summary>One subnet the user asks for.</summary>
public class NetworkStackSubnetSpec
{
    [BsonElement("name")] public string? Name { get; set; }
    [BsonElement("cidr")] public string? Cidr { get; set; }
    /// <summary>Optional AZ suffix (e.g. "a"); terraform defaults spread subnets across AZs.</summary>
    [BsonElement("az")] public string? Az { get; set; }
}

/// <summary>User-supplied inputs for a Network Stack.</summary>
[BsonIgnoreExtraElements]
public class NetworkStackSpec : BaseSpec
{
    [BsonElement("region")] public string? Region { get; set; }
    [BsonElement("vpcCidr")] public string? VpcCidr { get; set; }
    /// <summary>Give instances public DNS hostnames inside the VPC (terraform enable_dns_hostnames).</summary>
    [BsonElement("enableDnsHostnames")] public bool EnableDnsHostnames { get; set; } = true;
    [BsonElement("subnets")] public List<NetworkStackSubnetSpec> Subnets { get; set; } = new();
    [BsonElement("tags")] public Dictionary<string, string>? Tags { get; set; }

    /// <summary>The on-demand action the user most recently requested (plan/apply). Stamping this via
    /// UpdateAsync is what routes the request to the resource's long-lived ticket — the skill dispatches
    /// on it (see NetworkStackAction.cs + the skill's SKILL.md).</summary>
    [BsonElement("lastRequestedAction")] public NetworkStackRequestedAction? LastRequestedAction { get; set; }

    /// <summary>When a terraform-feeding spec field last changed (stamped server-side in
    /// OnBeforeUpdateAsync). Lives on the SPEC deliberately: the skill re-POSTs the whole Result after
    /// every run, so an edit marker stored in Result.Actions would be erased — the spec is user-owned and
    /// survives result writes. Feeds the plan-before-apply gate (ComputeApplyAllowed).</summary>
    [BsonElement("tfInputsChangedAt")] public DateTime? TfInputsChangedAt { get; set; }
}

/// <summary>Terraform outputs + run/module bookkeeping the skill writes back.</summary>
[BsonIgnoreExtraElements]
public class NetworkStackResult : BaseResult
{
    [BsonElement("vpcId")] public string? VpcId { get; set; }
    [BsonElement("subnetIds")] public List<string> SubnetIds { get; set; } = new();
    [BsonElement("securityGroupId")] public string? SecurityGroupId { get; set; }

    /// <summary>Per-module progress, posted progressively by the skill's watch loop during a run.</summary>
    [BsonElement("modules")] public List<NetworkStackModule> Modules { get; set; } = new();

    /// <summary>Audit log of every run (initial provision + on-demand plans/applies), appended by the skill.</summary>
    [BsonElement("actions")] public List<NetworkStackActionHistoryEntry> Actions { get; set; } = new();

    /// <summary>plan only: whether the most recent plan reported changes.</summary>
    [BsonElement("lastPlanHasDiff")] public bool LastPlanHasDiff { get; set; }

    /// <summary>Live subnet state — injected by EnrichResultAsync on GET, NEVER persisted.</summary>
    [BsonIgnore] public List<NetworkStackLiveSubnet>? LiveSubnets { get; set; }

    /// <summary>
    /// Apply gate, stamped by the service on every read (EnrichResultAsync) from ComputeApplyAllowed —
    /// a plain settable property so the FE always sees a value even when enrichment is skipped or fails.
    /// </summary>
    [BsonIgnore]
    public bool ApplyAllowed { get; set; }

    /// <summary>
    /// The plan-before-apply derivation (nothing to clear): Apply is allowed only when a plan has
    /// SUCCEEDED since the last successful apply/provision AND since the last spec edit
    /// (<paramref name="specEditedAt"/> = Spec.TfInputsChangedAt — kept on the spec because the skill
    /// re-POSTs the whole Result after every run, which would erase any marker stored here). The FIRST
    /// provision is skill-initiated (not this button), so the gate only affects on-demand runs.
    /// </summary>
    public bool ComputeApplyAllowed(DateTime? specEditedAt)
    {
        var lastApply = Actions
            .Where(a => string.Equals(a.Action, "apply", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(a.Action, "provision", StringComparison.OrdinalIgnoreCase))
            .Where(a => string.Equals(a.Status, "Complete", StringComparison.OrdinalIgnoreCase))
            .Select(a => a.RequestedAt)
            .DefaultIfEmpty(DateTime.MinValue)
            .Max();
        var lastEdit = specEditedAt ?? DateTime.MinValue;
        var gate = lastApply > lastEdit ? lastApply : lastEdit;
        return Actions.Any(a =>
            string.Equals(a.Action, "plan", StringComparison.OrdinalIgnoreCase)
            && string.Equals(a.Status, "Complete", StringComparison.OrdinalIgnoreCase)
            && a.RequestedAt >= gate);
    }
}

/// <summary>The entity — own Mongo collection; origin type/sub-type drive skill-mapping + ticket origin.</summary>
[BsonCollection("extension_networkstacks")]
[BsonIgnoreExtraElements]
public class NetworkStack : ResourceBase<NetworkStackSpec, NetworkStackResult>
{
    public override string GetTicketOriginType() => "NetworkStack";
    public override string GetTicketOriginSubType() => "network-stack";
}

/// <summary>No-op hooks (framework default). See reference/04-hooks.md for the invariants base.</summary>
public class NetworkStackHooks : DefaultEntityHooks<NetworkStack>
{
}

/// <summary>
/// Standard resource service + the action-driven surface: TriggerActionAsync stamps
/// Spec.LastRequestedAction and saves, which makes the platform message the SAME long-lived ticket;
/// history/log reads come from the ticket workdir via ITicketService; EnrichResultAsync injects live
/// subnet state from AWS on every GET.
/// </summary>
public class NetworkStackService : ResourceServiceBase<NetworkStack, NetworkStackSpec, NetworkStackResult>
{
    // Where the skill writes per-run artifacts inside the ticket workdir. NOTE: bash-written files under
    // canvas-documents/ do NOT auto-open the chat canvas panel — the extension's Logs tab reads them via
    // the endpoints below instead.
    private const string PlansDir = "canvas-documents/plans";
    private const string AppliesDir = "canvas-documents/applies";

    private readonly IRepository<NetworkStack> _repo;
    private readonly ILogger<NetworkStackService> _log;
    private readonly IServiceScopeFactory _scopes;
    private readonly IHttpContextAccessor _http;
    private readonly IScopeClientFactory _clients;

    public NetworkStackService(
        IRepository<NetworkStack> repository,
        ILogger<NetworkStackService> logger,
        IServiceScopeFactory scopeFactory,
        IHttpContextAccessor httpContextAccessor,
        IScopeClientFactory scopeClients)
        : base(repository, logger, scopeFactory, httpContextAccessor)
    {
        _repo = repository;
        _log = logger;
        _scopes = scopeFactory;
        _http = httpContextAccessor;
        _clients = scopeClients;
    }

    protected override async Task ValidateSpecAsync(NetworkStackSpec spec, bool isUpdate, NetworkStackSpec? existingSpec, CancellationToken ct)
    {
        await base.ValidateSpecAsync(spec, isUpdate, existingSpec, ct);
        if (spec.ScopeIds is null || spec.ScopeIds.Count == 0)
            throw new ArgumentException("An AWS scope is required — its credentials run terraform and the live-state reads.");
        if (string.IsNullOrWhiteSpace(spec.Region))
            throw new ArgumentException("Region is required (e.g. us-east-1).");
        if (!IsCidr(spec.VpcCidr))
            throw new ArgumentException($"VPC CIDR '{spec.VpcCidr}' is not a valid CIDR (e.g. 10.20.0.0/16).");
        if (spec.Subnets.Count == 0)
            throw new ArgumentException("At least one subnet is required.");
        foreach (var s in spec.Subnets)
        {
            if (string.IsNullOrWhiteSpace(s.Name))
                throw new ArgumentException("Every subnet needs a name.");
            if (!IsCidr(s.Cidr))
                throw new ArgumentException($"Subnet '{s.Name}' CIDR '{s.Cidr}' is not a valid CIDR (e.g. 10.20.1.0/24).");
        }
        // Terraform keys subnets by name (for_each) — a duplicate would fail the RUN with a cryptic
        // "Duplicate object key"; reject it here as a 400 at save time instead.
        var dup = spec.Subnets.GroupBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault(g => g.Count() > 1);
        if (dup is not null)
            throw new ArgumentException($"Subnet names must be unique — '{dup.Key}' appears {dup.Count()} times.");
    }

    private static bool IsCidr(string? cidr)
    {
        if (string.IsNullOrWhiteSpace(cidr)) return false;
        var parts = cidr.Split('/');
        return parts.Length == 2
               && System.Net.IPAddress.TryParse(parts[0], out _)
               && int.TryParse(parts[1], out var bits) && bits is >= 8 and <= 32;
    }

    // ── On-demand actions (Plan / Apply buttons) ─────────────────────────────────────────────────────

    /// <summary>
    /// Record a user-requested run. The stamp + UpdateAsync makes the platform send a message to the
    /// resource's EXISTING provisioning ticket (never a new one); the skill reads
    /// spec.lastRequestedAction and runs the verb. Deprovision is deliberately NOT a verb here — it is
    /// its own lifecycle (reference/11) and must never be short-circuited through this endpoint.
    /// </summary>
    public async Task TriggerActionAsync(string workspaceId, string id, string action, CancellationToken ct)
    {
        if (action is not ("plan" or "apply"))
            throw new ArgumentException($"Invalid action '{action}'. Allowed: plan | apply.");
        // Raw repository read — this is a guard + stamp path, not a view: skip EnrichResultAsync's AWS
        // round-trip (reference/12: keep enrichment on the READ path only).
        var entity = await _repo.GetByIdAsync(id, ct) ?? throw new KeyNotFoundException($"Resource '{id}' not found");
        if (entity.OwnerWorkspaceId != workspaceId)
            throw new KeyNotFoundException($"Resource '{id}' not found in workspace '{workspaceId}'");
        if (string.IsNullOrEmpty(entity.TicketContext?.TicketId))
            throw new InvalidOperationException($"Resource '{id}' has no ticket yet — wait for provisioning to start.");
        if (entity.Spec is null)
            throw new InvalidOperationException($"Resource '{id}' has no Spec.");
        if (entity.Status is ResourceStatus.DeprovisionInitiated or ResourceStatus.DeProvisioning
            or ResourceStatus.DeprovisionFailed or ResourceStatus.DeProvisioned)
            throw new InvalidOperationException(
                $"Resource '{id}' is being (or has been) deprovisioned — plan/apply actions are disabled.");
        // Single-flight from the backend side: a run is dispatched only from a settled state. (The skill's
        // shared/.run-lock is the second belt — the FE's disabled buttons are advisory, not a gate.)
        if (entity.Status is not (ResourceStatus.Complete or ResourceStatus.Failed))
            throw new InvalidOperationException(
                $"Resource '{id}' is {entity.Status} — plan/apply is available once the current operation finishes (Complete or Failed).");
        // A changed spec must be previewed before it mutates infra: plan is never gated (it IS the gate).
        if (action == "apply" && entity.Result is null)
            throw new InvalidOperationException(
                "Nothing to apply yet — wait for the initial provisioning result, then run a Plan first.");
        if (action == "apply" && !entity.Result!.ComputeApplyAllowed(entity.Spec.TfInputsChangedAt))
            throw new InvalidOperationException(
                "Run a Plan first — Apply is allowed only after a plan succeeds (and after every spec edit).");

        entity.Spec.LastRequestedAction = new NetworkStackRequestedAction
        {
            Action = action,
            RequestedAt = DateTime.UtcNow,
            RequestedBy = CallerId(),
        };
        await UpdateAsync(id, entity, ct);
    }

    /// <summary>
    /// Invalidate the plan-before-apply gate when an update changes what terraform will build: stamp
    /// Spec.TfInputsChangedAt so ComputeApplyAllowed demands a FRESH plan (newer than this edit). The
    /// stamp lives on the SPEC — the skill re-POSTs the whole Result after every run, so a marker stored
    /// in Result.Actions would be silently erased by the next run. Runs inside UpdateAsync before
    /// persistence, so the stamp lands with the same write.
    /// </summary>
    protected override async Task OnBeforeUpdateAsync(NetworkStack existing, NetworkStack updated, CancellationToken ct)
    {
        await base.OnBeforeUpdateAsync(existing, updated, ct);
        if (updated.Spec is null)
            return;
        // Carry the previous stamp forward (the FE's PATCH body doesn't know the field), then bump it
        // only when the terraform inputs actually differ.
        updated.Spec.TfInputsChangedAt ??= existing.Spec?.TfInputsChangedAt;
        if (TerraformInputsChanged(existing.Spec, updated.Spec))
            updated.Spec.TfInputsChangedAt = DateTime.UtcNow;
    }

    /// <summary>True when the fields that feed terraform differ — NOT LastRequestedAction/ScopeIds, so
    /// stamping an action (TriggerActionAsync) never counts as an edit.</summary>
    private static bool TerraformInputsChanged(NetworkStackSpec? a, NetworkStackSpec? b)
    {
        if (a is null || b is null) return a is not null || b is not null;
        static string Key(NetworkStackSpec s) => JsonSerializer.Serialize(new
        {
            region = s.Region,
            vpcCidr = s.VpcCidr,
            enableDnsHostnames = s.EnableDnsHostnames,
            subnets = s.Subnets.Select(x => new { x.Name, x.Cidr, x.Az }).ToList(),
            tags = s.Tags is null ? null : new SortedDictionary<string, string>(s.Tags),
        });
        return Key(a) != Key(b);
    }

    /// <summary>Who pressed the button — from the request's JWT claims (see reference/13).</summary>
    private string? CallerId()
    {
        var user = _http.HttpContext?.User;
        return user?.FindFirst("email")?.Value
               ?? user?.FindFirst(ClaimTypes.Email)?.Value
               ?? user?.FindFirst("preferred_username")?.Value
               ?? user?.Identity?.Name;
    }

    // ── Run history + logs (Logs tab) — read from the ticket workdir via ITicketService ─────────────

    public Task<IReadOnlyList<NetworkStackRunMeta>> GetPlanHistoryAsync(string workspaceId, string id, CancellationToken ct)
        => HistoryAsync(workspaceId, id, PlansDir, ct);
    public Task<IReadOnlyList<NetworkStackRunMeta>> GetApplyHistoryAsync(string workspaceId, string id, CancellationToken ct)
        => HistoryAsync(workspaceId, id, AppliesDir, ct);
    public Task<NetworkStackRunDetail?> GetPlanAsync(string workspaceId, string id, string runId, CancellationToken ct)
        => DetailAsync(workspaceId, id, PlansDir, runId, ct);
    public Task<NetworkStackRunDetail?> GetApplyAsync(string workspaceId, string id, string runId, CancellationToken ct)
        => DetailAsync(workspaceId, id, AppliesDir, runId, ct);

    private async Task<IReadOnlyList<NetworkStackRunMeta>> HistoryAsync(string workspaceId, string id, string dir, CancellationToken ct)
    {
        var ticketId = await ResolveTicketIdAsync(workspaceId, id, ct);
        if (ticketId is null) return Array.Empty<NetworkStackRunMeta>();
        var metas = await ListMetaFilesAsync(ticketId, dir, ct);
        return metas.OrderByDescending(m => m.RanAt).ToList();
    }

    private async Task<NetworkStackRunDetail?> DetailAsync(string workspaceId, string id, string dir, string runId, CancellationToken ct)
    {
        var ticketId = await ResolveTicketIdAsync(workspaceId, id, ct);
        if (ticketId is null) return null;
        using var scope = _scopes.CreateScope();
        var ts = scope.ServiceProvider.GetRequiredService<ITicketService>();
        var meta = await ReadMetaAsync(ts, ticketId, $"{dir}/{runId}.meta.json", ct);
        if (meta is null) return null;
        var log = await SafeReadAsync(ts, ticketId, $"{dir}/{runId}.log", ct) ?? "";
        return new NetworkStackRunDetail { Meta = meta, Log = log };
    }

    private async Task<string?> ResolveTicketIdAsync(string workspaceId, string id, CancellationToken ct)
    {
        // Raw repository read — only TicketContext is needed; going through GetByIdAsync would drag the
        // AWS enrichment call into every history/log request.
        var entity = await _repo.GetByIdAsync(id, ct);
        if (entity is null || entity.OwnerWorkspaceId != workspaceId) return null;
        return entity.TicketContext?.TicketId;
    }

    private async Task<List<NetworkStackRunMeta>> ListMetaFilesAsync(string ticketId, string dir, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var ts = scope.ServiceProvider.GetRequiredService<ITicketService>();
        IEnumerable<Duplo.Ai.FileStore.Storage.LocalFileInfo> entries;
        try { entries = await ts.ListTicketFilesAsync(ticketId, dir, ct); }
        catch (DirectoryNotFoundException) { return new(); }
        catch (FileNotFoundException) { return new(); }
        catch (Exception ex) { _log.LogWarning(ex, "ListTicketFiles failed for {Dir}", dir); return new(); }
        var metas = new List<NetworkStackRunMeta>();
        foreach (var info in entries.Where(e => !e.IsDirectory && e.Name.EndsWith(".meta.json", StringComparison.Ordinal)))
        {
            var m = await ReadMetaAsync(ts, ticketId, $"{dir}/{info.Name}", ct);
            if (m is not null) metas.Add(m);
        }
        return metas;
    }

    private async Task<NetworkStackRunMeta?> ReadMetaAsync(ITicketService ts, string ticketId, string relPath, CancellationToken ct)
    {
        var raw = await SafeReadAsync(ts, ticketId, relPath, ct);
        if (string.IsNullOrWhiteSpace(raw)) return null;
        try { return JsonSerializer.Deserialize<NetworkStackRunMeta>(raw, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }); }
        catch (JsonException ex) { _log.LogWarning(ex, "Bad run meta at {Path}", relPath); return null; }
    }

    private async Task<string?> SafeReadAsync(ITicketService ts, string ticketId, string relPath, CancellationToken ct)
    {
        try { return await ts.GetTicketFileAsync(ticketId, relPath, ct); }
        catch (FileNotFoundException) { return null; }
        catch (Exception ex) { _log.LogWarning(ex, "GetTicketFile failed for {Path}", relPath); return null; }
    }

    // ── Live state on GET (Network tab) — reference/12 ──────────────────────────────────────────────

    // Short TTL cache so the view's 3s poll doesn't turn every GET into an AWS round-trip (reference/12:
    // keep enrichment fast — it runs on the read path). Static = one cache per loaded extension DLL.
    private static readonly ConcurrentDictionary<string, (DateTime At, List<NetworkStackLiveSubnet> Subnets)> LiveSubnetCache = new();
    private static readonly TimeSpan LiveSubnetTtl = TimeSpan.FromSeconds(15);

    /// <summary>
    /// Inject the CURRENT AWS subnet state (never persisted) so the Network tab shows live truth, not
    /// the last apply's snapshot. Guarded so an enrichment failure (missing scope, revoked creds, AWS
    /// outage) can never break GET — the persisted result still renders.
    /// </summary>
    protected override async Task EnrichResultAsync(NetworkStack entity, CancellationToken ct)
    {
        if (entity.Result is not null)
        {
            // Stamp the plan-before-apply gate on every READ (before any live-state fetch, so the FE gets
            // a value even when enrichment is skipped or fails). Derivation: ComputeApplyAllowed.
            entity.Result.ApplyAllowed = entity.Result.ComputeApplyAllowed(entity.Spec?.TfInputsChangedAt);
        }
        var vpcId = entity.Result?.VpcId;
        var region = entity.Spec?.Region;
        var scopeIds = entity.Spec?.ScopeIds;
        if (entity.Result is null || string.IsNullOrWhiteSpace(vpcId) || string.IsNullOrWhiteSpace(region)
            || scopeIds is null || scopeIds.Count == 0)
            return;
        if (entity.Id is not null && LiveSubnetCache.TryGetValue(entity.Id, out var hit)
            && DateTime.UtcNow - hit.At < LiveSubnetTtl)
        {
            entity.Result.LiveSubnets = hit.Subnets;
            return;
        }
        try
        {
            // AWSSDK.EC2 is an explicit compile-only PackageReference (see the csproj comment).
            using var ec2 = await _clients.CreateAwsClientAsync(
                scopeIds, region!, (creds, r) => new AmazonEC2Client(creds, r), ct: ct);
            // AWS SDK v4: request collections are NOT auto-initialized (InitializeCollections defaults
            // to false), so `Filters = { … }` would Add() onto a null list — always new the List.
            var resp = await ec2.DescribeSubnetsAsync(new DescribeSubnetsRequest
            {
                Filters = new List<Filter> { new("vpc-id", new List<string> { vpcId! }) },
            }, ct);
            // v4 leaves RESPONSE collections null too when empty — never dot into them bare.
            var live = (resp.Subnets ?? new List<Subnet>()).Select(s => new NetworkStackLiveSubnet
            {
                SubnetId = s.SubnetId,
                Cidr = s.CidrBlock,
                AvailabilityZone = s.AvailabilityZone,
                State = s.State?.Value,
                AvailableIps = s.AvailableIpAddressCount,
            }).ToList();
            entity.Result.LiveSubnets = live;
            if (entity.Id is not null)
            {
                LiveSubnetCache[entity.Id] = (DateTime.UtcNow, live);
                // Prune expired entries on the write path — the dictionary is static (lives as long as
                // the hot-loaded DLL) and would otherwise grow one entry per resource ever viewed.
                foreach (var stale in LiveSubnetCache.Where(kv => DateTime.UtcNow - kv.Value.At > LiveSubnetTtl * 4).ToList())
                    LiveSubnetCache.TryRemove(stale.Key, out _);
            }
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Live subnet enrichment failed for {Id} — serving the persisted result", entity.Id);
        }
    }
}
