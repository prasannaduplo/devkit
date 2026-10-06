using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.DataManagement.Services;
using Duplo.Ai.Model.Attributes;
using Duplo.Ai.Model.Interfaces;
using Duplo.Ai.Model.Resource;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.RdsUpgrade;

// WORKER extension — upgrades an RDS instance across a major engine version using an AWS Blue/Green
// Deployment instead of an in-place upgrade (near-zero downtime vs. 10-30+ minutes of hard downtime).
// v1 is a single-shot ApplyAsync: precheck -> snapshot -> clone param group -> create Blue/Green
// (guarded against Duplo's own reconciler deleting the green instance mid-creation) -> validate ->
// switchover -> post-verify -> cleanup, all in one worker pass. No human-approval gate in v1 -- see
// EXTENSION_BACKLOG.md #36 for why (ResourceWorkerBase's multi-tick "wait indefinitely" semantics
// aren't verified against this SDK version) and what v2 should add back.

[BsonIgnoreExtraElements]
public class RdsUpgradeStep
{
    public string Phase { get; set; } = "";
    public DateTime StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public string Status { get; set; } = "";
    public string? Message { get; set; }
}

[BsonIgnoreExtraElements]
public class RdsUpgradeSpec : BaseSpec
{
    /// <summary>Source RDS instance identifier to upgrade.</summary>
    public string? DbInstanceIdentifier { get; set; }

    /// <summary>AWS region the instance lives in.</summary>
    public string? Region { get; set; }

    /// <summary>Target engine version (must be >= the instance's current version).</summary>
    public string? TargetEngineVersion { get; set; }

    /// <summary>Target instance class. Defaults to the source instance's class when blank.</summary>
    public string? TargetInstanceClass { get; set; }

    /// <summary>Target parameter group name. Defaults to a clone of the source's custom group when blank.</summary>
    public string? TargetParameterGroupName { get; set; }

    /// <summary>Max minutes to wait for AWS's SwitchoverBlueGreenDeployment call.</summary>
    public int SwitchoverTimeoutMinutes { get; set; } = 5;
}

[BsonIgnoreExtraElements]
public class RdsUpgradeResult : BaseResult
{
    /// <summary>Current phase — drives the status badge in the UI.</summary>
    public string Phase { get; set; } = "Requested";

    /// <summary>Ordered step history, rendered as a timeline.</summary>
    public List<RdsUpgradeStep> StepHistory { get; set; } = new();

    public string? SourceEngine { get; set; }
    public string? SourceEngineVersion { get; set; }
    public string? SnapshotIdentifier { get; set; }
    public string? ParameterGroupName { get; set; }
    public string? BlueGreenDeploymentId { get; set; }
    public string? GreenInstanceIdentifier { get; set; }
    public string? GreenEndpoint { get; set; }
    public string? OldInstanceIdentifier { get; set; }
    public string? FinalEndpoint { get; set; }
    public string? ErrorMessage { get; set; }
}

[BsonCollection("extension_rdsupgrades")]
public class RdsUpgrade : ResourceBase<RdsUpgradeSpec, RdsUpgradeResult>
{
    public override string GetTicketOriginType() => "RdsUpgrade";
    public override string GetTicketOriginSubType() => "rds-upgrade";
}

public class RdsUpgradeHooks : DefaultEntityHooks<RdsUpgrade>
{
}

/// <summary>
/// No skill mapping -> returning <see cref="ProvisioningMode.Worker"/> routes create/update through the
/// background <see cref="RdsUpgradeWorker"/>, which holds the actual AWS Blue/Green orchestration.
/// </summary>
public class RdsUpgradeService : ResourceServiceBase<RdsUpgrade, RdsUpgradeSpec, RdsUpgradeResult>
{
    public RdsUpgradeService(
        IRepository<RdsUpgrade> repository,
        ILogger<RdsUpgradeService> logger,
        IServiceScopeFactory scopeFactory,
        IHttpContextAccessor httpContextAccessor)
        : base(repository, logger, scopeFactory, httpContextAccessor)
    {
    }

    protected override ProvisioningMode NoSkillsFallbackMode => ProvisioningMode.Worker;

    protected override Task ValidateSpecAsync(RdsUpgradeSpec spec, bool isUpdate, RdsUpgradeSpec? existingSpec, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(spec.DbInstanceIdentifier))
            throw new ArgumentException("DbInstanceIdentifier is required.");
        if (string.IsNullOrWhiteSpace(spec.Region))
            throw new ArgumentException("Region is required.");
        if (string.IsNullOrWhiteSpace(spec.TargetEngineVersion))
            throw new ArgumentException("TargetEngineVersion is required.");
        if (spec.ScopeIds == null || spec.ScopeIds.Count == 0)
            throw new ArgumentException("Attach an AWS scope to upgrade an RDS instance.");
        return Task.CompletedTask;
    }
}
