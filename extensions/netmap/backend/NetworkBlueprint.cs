using Amazon.EC2;
using Amazon.EC2.Model;
using Amazon.EKS;
using Amazon.Runtime;
using Amazon.SecurityToken;
using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.DataManagement.Services;
using Duplo.Ai.DataManagement.Utils;
using Duplo.Ai.Model.Attributes;
using Duplo.Ai.Model.Interfaces;
using Duplo.Ai.Model.Resource;
using Duplo.Ai.Studio.Extensibility.Infra;
using Duplo.Extension.NetMap.Core.Aws;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.K8s;
using Duplo.Extension.NetMap.Core.Scan;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.NetMap;

// A Network Blueprint is a purpose + a hand-picked set of networks from any mix of scopes and regions. Worker mode:
// create / "Scan now" (ScanRequestedAt bump) / member edits start a staged snapshot scan (NetworkBlueprintWorker).
// Spec.ScopeIds is DERIVED from Members -- never user-entered -- so the platform's scope-access checks keep working.
// Every AWS client is created with exactly ONE scope (the member's), never the whole ScopeIds list.

[BsonIgnoreExtraElements]
public class NetworkBlueprintSpec : BaseSpec
{
    public string? Purpose { get; set; }
    public Dictionary<string, string> Labels { get; set; } = new();
    public List<BlueprintMember> Members { get; set; } = new();
    public DateTime? ScanRequestedAt { get; set; }
}

[BsonIgnoreExtraElements]
public class NetworkBlueprintResult : BaseResult
{
    public ActiveScanInfo? ActiveScan { get; set; }
    public int LastSequence { get; set; }
    public string? LatestSnapshotId { get; set; }
    public SnapshotSummary? LatestSummary { get; set; }
    public List<MemberStatus> MemberStatuses { get; set; } = new();
    public string? LastMembersHash { get; set; }
    public DateTime? LastScanRequestedAt { get; set; }
    public string? LastError { get; set; }
}

[BsonCollection("extension_networkblueprints")]
public class NetworkBlueprint : ResourceBase<NetworkBlueprintSpec, NetworkBlueprintResult>
{
    public override string GetTicketOriginType() => "NetworkBlueprint";
    public override string GetTicketOriginSubType() => "network-blueprint";
}

public class NetworkBlueprintHooks : DefaultEntityHooks<NetworkBlueprint>
{
}

public record PickerVpc(string VpcId, string Name, List<string> Cidrs, int SubnetCount, Dictionary<string, string> Tags, bool IsDefault);

public record WorkUnitView(string Id, string Collector, string ScopeId, string Region, string Status, int Attempts, string? Error, string? MissingPermission, DateTime? CollectedAt);

public record SnapshotHeader(string Id, int Sequence, string Trigger, string ScanStatus, DateTime StartedAt, DateTime? FinishedAt, string? SameAsSnapshotId, SnapshotSummary? Summary, List<WorkUnitView> Units);

public class NetworkBlueprintService : ResourceServiceBase<NetworkBlueprint, NetworkBlueprintSpec, NetworkBlueprintResult>
{
    private readonly IScopeCredentials _creds;
    private readonly IScopeClientFactory _clients;
    private readonly IServiceScopeFactory _scopes;
    private readonly IHttpContextAccessor _http;
    private readonly ILogger<NetworkBlueprintService> _logger;

    public NetworkBlueprintService(
        IRepository<NetworkBlueprint> repository,
        ILogger<NetworkBlueprintService> logger,
        IServiceScopeFactory scopeFactory,
        IHttpContextAccessor httpContextAccessor,
        IScopeCredentials creds,
        IScopeClientFactory clients)
        : base(repository, logger, scopeFactory, httpContextAccessor)
    {
        _creds = creds;
        _clients = clients;
        _scopes = scopeFactory;
        _http = httpContextAccessor;
        _logger = logger;
    }

    protected override ProvisioningMode NoSkillsFallbackMode => ProvisioningMode.Worker;

    protected override bool AutoDeleteOnDeProvision(NetworkBlueprint? entity) => true;

    protected override async Task ValidateSpecAsync(NetworkBlueprintSpec spec, bool isUpdate, NetworkBlueprintSpec? existingSpec, CancellationToken ct)
    {
        spec.Members ??= new List<BlueprintMember>();
        spec.Labels ??= new Dictionary<string, string>();
        BlueprintRules.Normalize(spec.Members);
        BlueprintRules.Validate(spec.Members);
        spec.ScopeIds = BlueprintRules.DerivedScopeIds(spec.Members);
        await AuthorizeScopesAsync(spec.ScopeIds, ct);
    }

    /// <summary>Every scope must resolve, be an AWS scope (v1), belong to the route's workspace (fail closed), and --
    /// when the platform exposes it -- be one the caller may use in this workspace.</summary>
    internal async Task AuthorizeScopesAsync(IReadOnlyCollection<string> scopeIds, CancellationToken ct)
    {
        var resolved = await _creds.ResolveAsync(scopeIds, ct);
        var unknown = scopeIds.Except(resolved.Select(r => r.Scope.Id)).ToList();
        if (unknown.Count > 0) throw new ArgumentException($"Unknown scope(s): {string.Join(", ", unknown)}.");

        var nonAws = resolved.FirstOrDefault(r => !string.Equals(r.Provider.Type, "aws", StringComparison.OrdinalIgnoreCase));
        if (nonAws != null)
            throw new ArgumentException($"Scope '{nonAws.Scope.Name}' is provider type '{nonAws.Provider.Type}'; this version supports AWS scopes only.");

        var http = _http.HttpContext;
        var workspaceId = http?.GetRouteValue("workspaceId") as string;
        if (http == null || string.IsNullOrWhiteSpace(workspaceId)) throw new ArgumentException(WorkspaceScopes.NotVerifiable);
        await EnsureScopesInWorkspaceAsync(http, workspaceId, scopeIds, ct);

        var permissions = http.RequestServices.GetService<ScopePermissionService>();
        var email = http.RequestServices.GetService<ICurrentUser>()?.Email;
        if (permissions != null && !string.IsNullOrEmpty(email))
        {
            var denied = (await permissions.GetDeniedScopeNamesAsync(email, workspaceId, scopeIds, ct))?.ToList() ?? new List<string>();
            if (denied.Count > 0) throw new ArgumentException($"You don't have access to scope(s): {string.Join(", ", denied)}.");
        }
    }

    /// <summary>IScopeCredentials resolves ANY scope id, so membership is checked explicitly. Preferred: the platform's
    /// ScopeHelper.ValidateAndGetProviderScopeAsync(workspaceId, scopeId, ct) -> Task&lt;(Provider, Scope)&gt; per scope.
    /// SDK 1.0.6 ships it bodiless and not every 1.0.6 build declares it on IScopeHelper, so it is bound by reflection on
    /// the resolved instance; a throw OR an empty / mismatched result counts as "not in this workspace". No validator →
    /// reject (no fallback: anything derived from the request, e.g. Host, is caller-controlled).</summary>
    private async Task EnsureScopesInWorkspaceAsync(HttpContext http, string workspaceId, IReadOnlyCollection<string> scopeIds, CancellationToken ct)
    {
        var ids = scopeIds.Distinct(StringComparer.Ordinal).ToList();
        var services = http.RequestServices;
        var (helper, validate) = FindScopeValidator(services);
        if (helper != null && validate != null)
        {
            _logger.LogInformation("Workspace scope check for {WorkspaceId} via ScopeHelper ({Count} scope(s))", workspaceId, ids.Count);
            var rejected = new List<string>();
            foreach (var id in ids)
            {
                try
                {
                    var task = (Task)validate.Invoke(helper, new object[] { workspaceId, id, ct })!;
                    await task;
                    var tuple = task.GetType().GetProperty("Result")?.GetValue(task);
                    var provider = tuple?.GetType().GetField("Item1")?.GetValue(tuple);
                    var scope = tuple?.GetType().GetField("Item2")?.GetValue(tuple);
                    var scopeId = scope?.GetType().GetProperty("Id")?.GetValue(scope) as string;
                    if (provider == null || !string.Equals(scopeId, id, StringComparison.Ordinal)) rejected.Add(id);
                }
                catch (Exception ex) when (!ct.IsCancellationRequested)
                {
                    var inner = ex is System.Reflection.TargetInvocationException { InnerException: { } ie } ? ie : ex;
                    _logger.LogWarning("ScopeHelper rejected scope {ScopeId} for workspace {WorkspaceId}: {Error}", id, workspaceId, inner.GetType().Name);
                    rejected.Add(id);
                }
            }
            if (rejected.Count > 0) throw new ArgumentException(WorkspaceScopes.NotInWorkspace(rejected));
            return;
        }

        _logger.LogWarning("Workspace scope check for {WorkspaceId}: no platform ScopeHelper validator available; rejecting", workspaceId);
        throw new ArgumentException(WorkspaceScopes.NotVerifiable);
    }

    private static (object? Helper, System.Reflection.MethodInfo? Validate) FindScopeValidator(IServiceProvider services)
    {
        var signature = new[] { typeof(string), typeof(string), typeof(CancellationToken) };
        foreach (var t in new[] { typeof(IScopeHelper), typeof(ScopeHelper) })
        {
            object? svc;
            try { svc = services.GetService(t); }
            catch (Exception) { continue; } // a registered helper whose own dependencies are missing
            var m = svc?.GetType().GetMethod("ValidateAndGetProviderScopeAsync", signature);
            if (svc != null && m != null && typeof(Task).IsAssignableFrom(m.ReturnType)) return (svc, m);
        }
        return (null, null);
    }

    public async Task<List<string>> ListRegionsAsync(string scopeId, CancellationToken ct)
    {
        await AuthorizeScopesAsync(new[] { scopeId }, ct);
        using var ec2 = await _clients.CreateAwsClientAsync(new[] { scopeId }, "us-east-1", (c, r) => new AmazonEC2Client(c, r), ct: ct);
        var resp = await ec2.DescribeRegionsAsync(new DescribeRegionsRequest(), ct);
        return Aws.L(resp.Regions).Select(r => r.RegionName).OrderBy(r => r, StringComparer.Ordinal).ToList();
    }

    public async Task<List<PickerVpc>> ListVpcsAsync(string scopeId, string region, CancellationToken ct)
    {
        await AuthorizeScopesAsync(new[] { scopeId }, ct);
        if (string.IsNullOrWhiteSpace(region) || Amazon.RegionEndpoint.GetBySystemName(region).DisplayName == "Unknown")
            throw new ArgumentException($"Unknown region '{region}'.");
        using var ec2 = await _clients.CreateAwsClientAsync(new[] { scopeId }, region, (c, r) => new AmazonEC2Client(c, r), ct: ct);
        var vpcs = await Aws.All(ec2.Paginators.DescribeVpcs(new DescribeVpcsRequest()).Vpcs, ct);
        var subnets = await Aws.All(ec2.Paginators.DescribeSubnets(new DescribeSubnetsRequest()).Subnets, ct);
        var subnetCounts = subnets.GroupBy(s => s.VpcId).ToDictionary(g => g.Key, g => g.Count());

        return vpcs.Select(v =>
        {
            var tags = Aws.Tags(v.Tags).ToDictionary(t => t.Key, t => t.Value);
            var cidrs = Aws.L(v.CidrBlockAssociationSet).Where(a => a.CidrBlockState?.State?.Value == "associated").Select(a => a.CidrBlock).OfType<string>().ToList();
            if (cidrs.Count == 0 && v.CidrBlock != null) cidrs.Add(v.CidrBlock);
            var name = tags.GetValueOrDefault("Name") is { Length: > 0 } n ? n : v.VpcId;
            return new PickerVpc(v.VpcId, name, cidrs, subnetCounts.GetValueOrDefault(v.VpcId), tags, v.IsDefault ?? false);
        }).OrderBy(v => v.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>v2b spike: can this scope's AWS identity read Kubernetes in the region's EKS clusters? Read-only:
    /// eks:ListClusters / eks:DescribeCluster, sts:GetCallerIdentity, then GET /version and SelfSubjectAccessReviews
    /// with an EKS bearer token built from the same credentials. The token never leaves this method.</summary>
    public async Task<List<K8sProbeResult>> ProbeK8sAsync(string scopeId, string region, CancellationToken ct)
    {
        await AuthorizeScopesAsync(new[] { scopeId }, ct);
        if (string.IsNullOrWhiteSpace(region) || Amazon.RegionEndpoint.GetBySystemName(region).DisplayName == "Unknown")
            throw new ArgumentException($"Unknown region '{region}'.");
        AWSCredentials? creds = null;
        using var eks = await _clients.CreateAwsClientAsync(new[] { scopeId }, region, (c, r) => { creds = c; return new AmazonEKSClient(c, r); }, ct: ct);
        using var sts = await _clients.CreateAwsClientAsync(new[] { scopeId }, region, (c, r) => new AmazonSecurityTokenServiceClient(c, r), ct: ct);
        if (creds == null) throw new InvalidOperationException($"No AWS credentials resolved for scope '{scopeId}'.");
        var results = await new EksProbe().ProbeAsync(eks, sts, creds, region, ct);
        _logger.LogInformation("K8s probe scope {ScopeId} region {Region}: {Clusters} cluster(s), {Reachable} reachable, {Readable} readable",
            scopeId, region, results.Count, results.Count(r => r.ApiReachable),
            results.Count(r => r.CanListPods == true && r.CanListServices == true && r.CanListNetworkPolicies == true));
        return results;
    }

    public async Task<List<SnapshotHeader>> ListSnapshotsAsync(NetworkBlueprint bp, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var repo = scope.ServiceProvider.GetRequiredService<IRepository<NetworkSnapshot>>();
        var snaps = await repo.GetAllAsync(s => s.Spec.BlueprintId == bp.Id, ct);
        var activeId = bp.Result?.ActiveScan?.SnapshotId;
        return snaps.OrderByDescending(s => s.Spec.Sequence).Select(s => ToHeader(s, activeId)).ToList();
    }

    /// <summary>Decoded graph for a snapshot of this blueprint ("latest" = the blueprint's latest), following
    /// SameAsSnapshotId for unchanged scans. A fresh copy per call (callers may mutate it). Null when not found.</summary>
    public async Task<NetworkGraph?> GetGraphAsync(NetworkBlueprint bp, string snapshotId, CancellationToken ct)
    {
        var id = snapshotId == "latest" ? bp.Result?.LatestSnapshotId : snapshotId;
        if (id == null) return null;
        using var scope = _scopes.CreateScope();
        var repo = scope.ServiceProvider.GetRequiredService<IRepository<NetworkSnapshot>>();
        var snap = await repo.GetByIdAsync(id, ct);
        if (snap?.Spec?.BlueprintId != bp.Id) return null;
        if (snap.Result?.Graph == null && snap.Result?.SameAsSnapshotId is { } same) snap = await repo.GetByIdAsync(same, ct);
        return snap?.Result?.Graph is { } bytes ? GraphCodec.Decode<NetworkGraph>(bytes) : null;
    }

    // A Running snapshot that is not the blueprint's active scan was orphaned (crash / failed save): report it as abandoned.
    private static SnapshotHeader ToHeader(NetworkSnapshot s, string? activeId) => new(
        s.Id, s.Spec.Sequence, s.Spec.Trigger, ((s.Result?.ScanStatus ?? ScanStatuses.Running) == ScanStatuses.Running && s.Id != activeId) ? "abandoned" : (s.Result?.ScanStatus ?? ScanStatuses.Running), s.Result?.StartedAt ?? s.CreatedAt,
        s.Result?.FinishedAt, s.Result?.SameAsSnapshotId, s.Result?.Summary,
        (s.Result?.Units ?? new()).Select(u => new WorkUnitView(u.Id, u.Collector, u.ScopeId, u.Region, u.Status, u.Attempts, u.Error, u.MissingPermission, u.CollectedAt)).ToList());
}
