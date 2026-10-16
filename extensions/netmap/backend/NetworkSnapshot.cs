using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.DataManagement.Services;
using Duplo.Ai.Model.Attributes;
using Duplo.Ai.Model.Interfaces;
using Duplo.Ai.Model.Resource;
using Duplo.Extension.NetMap.Core.Scan;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.NetMap;

// Hidden resource: one row per scan, written only by NetworkBlueprintWorker through IRepository<NetworkSnapshot>
// (never through this service, which rejects API writes). Graph and unit parts are gzip JSON byte[] -- see
// GraphCodec. Schema changes are additive-only (BsonIgnoreExtraElements everywhere).

[BsonIgnoreExtraElements]
public class NetworkSnapshotSpec : BaseSpec
{
    public string BlueprintId { get; set; } = "";
    public int Sequence { get; set; }
    public string Trigger { get; set; } = "manual";               // create | manual | (v4) scheduled
    public List<BlueprintMember> Members { get; set; } = new();    // frozen at scan start
}

[BsonIgnoreExtraElements]
public class NetworkSnapshotResult : BaseResult
{
    public string ScanStatus { get; set; } = ScanStatuses.Running;
    public DateTime StartedAt { get; set; }
    public DateTime? FinishedAt { get; set; }
    public int SchemaVersion { get; set; } = 1;
    public string? ContentHash { get; set; }
    public string? SameAsSnapshotId { get; set; }
    public List<WorkUnit> Units { get; set; } = new();
    public byte[]? Graph { get; set; }
    public SnapshotSummary? Summary { get; set; }
    public List<MemberStatus> MemberStatuses { get; set; } = new();   // persisted so an interrupted finalize can be adopted
    public string? Error { get; set; }
}

[BsonCollection("extension_networksnapshots")]
public class NetworkSnapshot : ResourceBase<NetworkSnapshotSpec, NetworkSnapshotResult>
{
    public override string GetTicketOriginType() => "NetworkSnapshot";
    public override string GetTicketOriginSubType() => "network-snapshot";
}

public class NetworkSnapshotHooks : DefaultEntityHooks<NetworkSnapshot>
{
}

public class NetworkSnapshotService : ResourceServiceBase<NetworkSnapshot, NetworkSnapshotSpec, NetworkSnapshotResult>
{
    public NetworkSnapshotService(
        IRepository<NetworkSnapshot> repository,
        ILogger<NetworkSnapshotService> logger,
        IServiceScopeFactory scopeFactory,
        IHttpContextAccessor httpContextAccessor)
        : base(repository, logger, scopeFactory, httpContextAccessor)
    {
    }

    protected override bool IsProvisioningNeeded(NetworkSnapshot entity) => false;

    // Snapshots go away only with their blueprint (worker deletes via the repository), never via the generic delete route.
    public override Task ValidateCanDeprovisionAsync(NetworkSnapshot entity, CancellationToken ct) =>
        throw new ArgumentException("Snapshots are removed with their blueprint.");

    protected override Task ValidateSpecAsync(NetworkSnapshotSpec spec, bool isUpdate, NetworkSnapshotSpec? existingSpec, CancellationToken ct) =>
        throw new ArgumentException("Network snapshots are created by Network Blueprint scans and cannot be created or edited through the API.");
}
