using Amazon.IdentityManagement;
using Amazon.IdentityManagement.Model;
using Amazon.RDS;
using Amazon.RDS.Model;
using Duplo.Ai.DataManagement.Services.Workers;
using Duplo.Ai.Studio.Extensibility.Infra;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Duplo.Extension.RdsUpgrade;

/// <summary>
/// Single-shot Worker that upgrades an RDS instance's major engine version via an AWS Blue/Green
/// Deployment. v1 runs precheck through cleanup in one <see cref="ApplyAsync"/> call — no human-approval
/// gate (see RdsUpgrade.cs header comment for why). AWS operations that take real time (Blue/Green
/// creation, switchover) are handled by polling loops inside this one call, not by returning between
/// ticks — the safest interpretation available of a framework contract this dev-kit's samples don't
/// exercise for anything longer than an instant compute.
/// </summary>
public class RdsUpgradeWorker : ResourceWorkerBase<RdsUpgrade, RdsUpgradeSpec, RdsUpgradeResult>
{
    private const string GuardPolicyNamePrefix = "rdsupgrade-guard-";
    private const string GuardRoleName = "duplomaster";

    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan SnapshotTimeout = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan BlueGreenCreateTimeout = TimeSpan.FromMinutes(60);

    public RdsUpgradeWorker(IServiceScopeFactory scopeFactory, ILogger<RdsUpgradeWorker> logger, IConfiguration? config = null)
        : base(scopeFactory, logger, config)
    {
    }

    protected override async Task ApplyAsync(RdsUpgrade e, IServiceProvider scope, CancellationToken ct)
    {
        e.Result ??= new RdsUpgradeResult();
        var spec = e.Spec ?? throw new InvalidOperationException("Spec is required.");
        var factory = scope.GetRequiredService<IScopeClientFactory>();

        string? guardPolicyName = null;
        // Declared outside the try (not `using var` inside it) so the catch block's best-effort rollback
        // can still reach it — a `using` local doesn't survive past the block it's declared in even though
        // the object itself stays alive until end-of-method disposal either way.
        AmazonRDSClient? rds = null;
        try
        {
            // Resolving the AWS client (including scope-attachment failures) belongs inside the try —
            // otherwise a bad/missing scope throws before any step is recorded and Result stays stuck at
            // "Requested" with an empty StepHistory even though the resource shows Failed. Caught live
            // during the first end-to-end test against prasanna-ws (no AWS scope attached yet).
            rds = await factory.CreateAwsClientAsync(
                spec.ScopeIds, spec.Region!, (c, r) => new AmazonRDSClient(c, r), ct: ct);

            var instance = await PrecheckAsync(e, rds, ct);
            await SnapshotAsync(e, rds, ct);
            await CreateParamGroupAsync(e, rds, instance, ct);
            var deploymentId = await CreateBlueGreenAsync(e, rds, instance, ct);

            using var iam = await factory.CreateAwsClientAsync(
                spec.ScopeIds, spec.Region!, (c, r) => new AmazonIdentityManagementServiceClient(c, r), ct: ct);
            guardPolicyName = await AttachDeleteGuardAsync(e, rds, iam, deploymentId, ct);

            await ValidateGreenAsync(e, rds, deploymentId, ct);
            await SwitchoverAsync(e, rds, deploymentId, ct);
            await PostVerifyAsync(e, rds, deploymentId, ct);
            await CleanupAsync(e, rds, deploymentId, ct);

            if (guardPolicyName != null)
                await DetachDeleteGuardAsync(iam, guardPolicyName, ct);

            e.Result.Phase = "Completed";
            await SaveProgressAsync(scope, e, "RDS upgrade completed.", ct);
        }
        catch (Exception ex)
        {
            e.Result.Phase = "Failed";
            e.Result.ErrorMessage = ex.Message;
            AppendStep(e, e.Result.Phase, "Failed", ex.Message);

            // Best-effort cleanup so a failed run doesn't leave the guard or an in-flight deployment behind.
            try
            {
                if (guardPolicyName != null)
                {
                    using var iam = await factory.CreateAwsClientAsync(
                        spec.ScopeIds, spec.Region!, (c, r) => new AmazonIdentityManagementServiceClient(c, r), ct: CancellationToken.None);
                    await DetachDeleteGuardAsync(iam, guardPolicyName, CancellationToken.None);
                }
                if (rds != null && !string.IsNullOrEmpty(e.Result.BlueGreenDeploymentId) && string.IsNullOrEmpty(e.Result.FinalEndpoint))
                {
                    await rds.DeleteBlueGreenDeploymentAsync(new DeleteBlueGreenDeploymentRequest
                    {
                        BlueGreenDeploymentIdentifier = e.Result.BlueGreenDeploymentId,
                        DeleteTarget = true,
                    }, CancellationToken.None);
                }
            }
            catch (Exception cleanupEx)
            {
                AppendStep(e, "Failed", "Failed", $"Rollback cleanup also failed: {cleanupEx.Message}");
            }

            await SaveProgressAsync(scope, e, $"Failed: {ex.Message}", ct);
            throw;
        }
        finally
        {
            rds?.Dispose();
        }
    }

    // ── Steps ──────────────────────────────────────────────────────────────

    private async Task<DBInstance> PrecheckAsync(RdsUpgrade e, IAmazonRDS rds, CancellationToken ct)
    {
        BeginStep(e, "Prechecking");
        var spec = e.Spec!;

        var describe = await rds.DescribeDBInstancesAsync(
            new DescribeDBInstancesRequest { DBInstanceIdentifier = spec.DbInstanceIdentifier }, ct);
        var instance = describe.DBInstances.FirstOrDefault()
            ?? throw new InvalidOperationException($"RDS instance '{spec.DbInstanceIdentifier}' not found.");

        if (!string.IsNullOrEmpty(instance.EngineVersion) &&
            CompareVersions(spec.TargetEngineVersion!, instance.EngineVersion) < 0)
        {
            throw new InvalidOperationException(
                $"Target engine version ({spec.TargetEngineVersion}) must be >= current version ({instance.EngineVersion}).");
        }

        var supported = new[] { "mysql", "postgres", "mariadb", "aurora-mysql", "aurora-postgresql" };
        if (!supported.Contains(instance.Engine, StringComparer.OrdinalIgnoreCase))
            throw new InvalidOperationException($"Engine '{instance.Engine}' does not support Blue/Green deployments.");

        var existing = await rds.DescribeBlueGreenDeploymentsAsync(new DescribeBlueGreenDeploymentsRequest(), ct);
        if (existing.BlueGreenDeployments.Any(d =>
                d.Source != null && d.Source.EndsWith($":{spec.DbInstanceIdentifier}", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(d.Status, "SWITCHOVER_COMPLETED", StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidOperationException($"'{spec.DbInstanceIdentifier}' already has an active Blue/Green deployment.");
        }

        e.Result!.SourceEngine = instance.Engine;
        e.Result.SourceEngineVersion = instance.EngineVersion;
        CompleteStep(e, "Prechecking", "OK");
        return instance;
    }

    private async Task SnapshotAsync(RdsUpgrade e, IAmazonRDS rds, CancellationToken ct)
    {
        BeginStep(e, "Snapshotting");
        var spec = e.Spec!;
        var snapshotId = $"{spec.DbInstanceIdentifier}-preupgrade-{DateTime.UtcNow:yyyyMMddHHmmss}";

        await rds.CreateDBSnapshotAsync(new CreateDBSnapshotRequest
        {
            DBInstanceIdentifier = spec.DbInstanceIdentifier,
            DBSnapshotIdentifier = snapshotId,
        }, ct);

        await PollUntilAsync(SnapshotTimeout, ct, async () =>
        {
            var d = await rds.DescribeDBSnapshotsAsync(
                new DescribeDBSnapshotsRequest { DBSnapshotIdentifier = snapshotId }, ct);
            var snap = d.DBSnapshots.FirstOrDefault();
            return string.Equals(snap?.Status, "available", StringComparison.OrdinalIgnoreCase);
        }, () => $"Waiting for snapshot '{snapshotId}' to become available.");

        e.Result!.SnapshotIdentifier = snapshotId;
        CompleteStep(e, "Snapshotting", "OK", $"Snapshot {snapshotId}");
    }

    private async Task CreateParamGroupAsync(RdsUpgrade e, IAmazonRDS rds, DBInstance instance, CancellationToken ct)
    {
        BeginStep(e, "CreatingParamGroup");
        var spec = e.Spec!;

        if (!string.IsNullOrWhiteSpace(spec.TargetParameterGroupName))
        {
            e.Result!.ParameterGroupName = spec.TargetParameterGroupName;
            CompleteStep(e, "CreatingParamGroup", "OK", "Using user-supplied parameter group.");
            return;
        }

        var sourceGroup = instance.DBParameterGroups?
            .FirstOrDefault(g => !g.DBParameterGroupName.StartsWith("default.", StringComparison.OrdinalIgnoreCase));

        if (sourceGroup == null)
        {
            CompleteStep(e, "CreatingParamGroup", "OK", "Source uses a default group — AWS will assign a default target group.");
            return;
        }

        var newGroupName = $"{spec.DbInstanceIdentifier}-bg-{spec.TargetEngineVersion!.Replace(".", "-")}";
        await rds.CopyDBParameterGroupAsync(new CopyDBParameterGroupRequest
        {
            SourceDBParameterGroupIdentifier = sourceGroup.DBParameterGroupName,
            TargetDBParameterGroupIdentifier = newGroupName,
            TargetDBParameterGroupDescription = $"Cloned from {sourceGroup.DBParameterGroupName} for Blue/Green upgrade to {spec.TargetEngineVersion}",
        }, ct);

        e.Result!.ParameterGroupName = newGroupName;
        CompleteStep(e, "CreatingParamGroup", "OK", $"Cloned {sourceGroup.DBParameterGroupName} -> {newGroupName}");
    }

    private async Task<string> CreateBlueGreenAsync(RdsUpgrade e, IAmazonRDS rds, DBInstance instance, CancellationToken ct)
    {
        BeginStep(e, "CreatingBlueGreen");
        var spec = e.Spec!;

        var request = new CreateBlueGreenDeploymentRequest
        {
            BlueGreenDeploymentName = $"{spec.DbInstanceIdentifier}-bg",
            Source = instance.DBInstanceArn,
            TargetEngineVersion = spec.TargetEngineVersion,
        };
        if (!string.IsNullOrWhiteSpace(spec.TargetInstanceClass))
            request.TargetDBInstanceClass = spec.TargetInstanceClass;
        if (!string.IsNullOrWhiteSpace(e.Result!.ParameterGroupName))
            request.TargetDBParameterGroupName = e.Result.ParameterGroupName;

        var response = await rds.CreateBlueGreenDeploymentAsync(request, ct);
        var deploymentId = response.BlueGreenDeployment.BlueGreenDeploymentIdentifier;
        e.Result!.BlueGreenDeploymentId = deploymentId;

        // Target ARN is usually already populated right after creation — grab the green identifier for
        // the delete-guard and for later lookups. Don't fail the step if it's not there yet; ValidateGreen
        // re-describes anyway.
        var described = await rds.DescribeBlueGreenDeploymentsAsync(
            new DescribeBlueGreenDeploymentsRequest { BlueGreenDeploymentIdentifier = deploymentId }, ct);
        var target = described.BlueGreenDeployments.FirstOrDefault()?.Target;
        if (!string.IsNullOrEmpty(target))
            e.Result.GreenInstanceIdentifier = ExtractIdentifierFromArn(target);

        CompleteStep(e, "CreatingBlueGreen", "OK", $"Deployment {deploymentId}");
        return deploymentId;
    }

    private async Task<string> AttachDeleteGuardAsync(RdsUpgrade e, IAmazonRDS rds, IAmazonIdentityManagementService iam, string deploymentId, CancellationToken ct)
    {
        // Duplo's own tenant reconciler has been observed deleting the AWS-created green instance mid-creation
        // because it doesn't yet recognize it as managed (it inherits a "duplo"-styled name). This explicit
        // Deny stops that race for the lifetime of this upgrade. See EXTENSION_BACKLOG.md #36 for the incident
        // this was learned from. Scoped to the specific green resource ARN, not a wildcard.
        var described = await rds.DescribeBlueGreenDeploymentsAsync(
            new DescribeBlueGreenDeploymentsRequest { BlueGreenDeploymentIdentifier = deploymentId }, ct);
        var targetArn = described.BlueGreenDeployments.FirstOrDefault()?.Target;
        if (string.IsNullOrEmpty(targetArn))
        {
            AppendStep(e, "CreatingBlueGreen", "Warning", "Could not resolve the green instance ARN yet — delete-guard not attached this pass.");
            return null!;
        }

        var policyName = $"{GuardPolicyNamePrefix}{e.Id}";
        var policyDoc = $@"{{
  ""Version"": ""2012-10-17"",
  ""Statement"": [
    {{
      ""Effect"": ""Deny"",
      ""Action"": [""rds:DeleteDBInstance"", ""rds:DeleteDBCluster""],
      ""Resource"": ""{targetArn}""
    }}
  ]
}}";
        await iam.PutRolePolicyAsync(new PutRolePolicyRequest
        {
            RoleName = GuardRoleName,
            PolicyName = policyName,
            PolicyDocument = policyDoc,
        }, ct);

        AppendStep(e, "CreatingBlueGreen", "OK", $"Delete-guard attached on {targetArn}");
        return policyName;
    }

    private async Task DetachDeleteGuardAsync(IAmazonIdentityManagementService iam, string policyName, CancellationToken ct)
    {
        try
        {
            await iam.DeleteRolePolicyAsync(new DeleteRolePolicyRequest
            {
                RoleName = GuardRoleName,
                PolicyName = policyName,
            }, ct);
        }
        catch (NoSuchEntityException)
        {
            // Already gone — nothing to do.
        }
    }

    private async Task ValidateGreenAsync(RdsUpgrade e, IAmazonRDS rds, string deploymentId, CancellationToken ct)
    {
        BeginStep(e, "ValidatingGreen");

        await PollUntilAsync(BlueGreenCreateTimeout, ct, async () =>
        {
            var d = await rds.DescribeBlueGreenDeploymentsAsync(
                new DescribeBlueGreenDeploymentsRequest { BlueGreenDeploymentIdentifier = deploymentId }, ct);
            var dep = d.BlueGreenDeployments.FirstOrDefault();
            if (string.Equals(dep?.Status, "INVALID_CONFIGURATION", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"Blue/Green deployment '{deploymentId}' reported INVALID_CONFIGURATION.");
            return string.Equals(dep?.Status, "AVAILABLE", StringComparison.OrdinalIgnoreCase);
        }, () => $"Waiting for Blue/Green deployment '{deploymentId}' to become AVAILABLE.");

        if (!string.IsNullOrEmpty(e.Result!.GreenInstanceIdentifier))
        {
            var green = await rds.DescribeDBInstancesAsync(
                new DescribeDBInstancesRequest { DBInstanceIdentifier = e.Result.GreenInstanceIdentifier }, ct);
            var gi = green.DBInstances.FirstOrDefault();
            if (gi?.Endpoint != null)
                e.Result.GreenEndpoint = $"{gi.Endpoint.Address}:{gi.Endpoint.Port}";
        }

        CompleteStep(e, "ValidatingGreen", "OK", e.Result!.GreenEndpoint);
    }

    private async Task SwitchoverAsync(RdsUpgrade e, IAmazonRDS rds, string deploymentId, CancellationToken ct)
    {
        BeginStep(e, "CuttingOver");
        var spec = e.Spec!;

        await rds.SwitchoverBlueGreenDeploymentAsync(new SwitchoverBlueGreenDeploymentRequest
        {
            BlueGreenDeploymentIdentifier = deploymentId,
            SwitchoverTimeout = spec.SwitchoverTimeoutMinutes * 60,
        }, ct);

        var timeout = TimeSpan.FromMinutes(spec.SwitchoverTimeoutMinutes + 5);
        await PollUntilAsync(timeout, ct, async () =>
        {
            var d = await rds.DescribeBlueGreenDeploymentsAsync(
                new DescribeBlueGreenDeploymentsRequest { BlueGreenDeploymentIdentifier = deploymentId }, ct);
            return string.Equals(d.BlueGreenDeployments.FirstOrDefault()?.Status, "SWITCHOVER_COMPLETED", StringComparison.OrdinalIgnoreCase);
        }, () => $"Waiting for switchover on '{deploymentId}' to complete.");

        CompleteStep(e, "CuttingOver", "OK");
    }

    private async Task PostVerifyAsync(RdsUpgrade e, IAmazonRDS rds, string deploymentId, CancellationToken ct)
    {
        BeginStep(e, "PostVerify");
        var spec = e.Spec!;

        // After switchover AWS renames the pre-upgrade (blue) instance to "<original>-old-<suffix>" and the
        // former-green instance takes over the original identifier/endpoint.
        var described = await rds.DescribeBlueGreenDeploymentsAsync(
            new DescribeBlueGreenDeploymentsRequest { BlueGreenDeploymentIdentifier = deploymentId }, ct);
        var dep = described.BlueGreenDeployments.FirstOrDefault();
        if (!string.IsNullOrEmpty(dep?.Source))
            e.Result!.OldInstanceIdentifier = ExtractIdentifierFromArn(dep.Source);

        var production = await rds.DescribeDBInstancesAsync(
            new DescribeDBInstancesRequest { DBInstanceIdentifier = spec.DbInstanceIdentifier }, ct);
        var prod = production.DBInstances.FirstOrDefault()
            ?? throw new InvalidOperationException($"Could not find '{spec.DbInstanceIdentifier}' after switchover.");
        if (!string.Equals(prod.EngineVersion, spec.TargetEngineVersion, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException(
                $"Post-verify failed: '{spec.DbInstanceIdentifier}' reports engine version {prod.EngineVersion}, expected {spec.TargetEngineVersion}.");

        if (prod.Endpoint != null)
            e.Result!.FinalEndpoint = $"{prod.Endpoint.Address}:{prod.Endpoint.Port}";

        CompleteStep(e, "PostVerify", "OK", e.Result!.FinalEndpoint);
    }

    private async Task CleanupAsync(RdsUpgrade e, IAmazonRDS rds, string deploymentId, CancellationToken ct)
    {
        BeginStep(e, "CleaningUp");

        if (!string.IsNullOrEmpty(e.Result!.OldInstanceIdentifier))
        {
            await rds.DeleteDBInstanceAsync(new DeleteDBInstanceRequest
            {
                DBInstanceIdentifier = e.Result.OldInstanceIdentifier,
                SkipFinalSnapshot = true, // a pre-upgrade snapshot was already taken in Snapshotting
            }, ct);
        }

        // Green is production now — DeleteTarget=false, only remove the deployment tracking object.
        await rds.DeleteBlueGreenDeploymentAsync(new DeleteBlueGreenDeploymentRequest
        {
            BlueGreenDeploymentIdentifier = deploymentId,
            DeleteTarget = false,
        }, ct);

        CompleteStep(e, "CleaningUp", "OK", $"Removed old instance {e.Result.OldInstanceIdentifier}");
    }

    // ── Worker seams with nothing to do in v1 ────────────────────────────────

    protected override Task VerifyDriftAsync(RdsUpgrade e, IServiceProvider scope, CancellationToken ct)
        => Task.CompletedTask;

    protected override Task DeleteSubResourcesAsync(RdsUpgrade e, IServiceProvider scope, CancellationToken ct)
        => Task.CompletedTask; // the upgraded RDS instance is the resource itself — deleting the row doesn't delete the DB.

    protected override Task<bool> WaitForDeletionAsync(RdsUpgrade e, IServiceProvider scope, CancellationToken ct)
        => Task.FromResult(true);

    // ── Helpers ───────────────────────────────────────────────────────────

    private static void BeginStep(RdsUpgrade e, string phase)
    {
        e.Result!.Phase = phase;
        e.Result.StepHistory.Add(new RdsUpgradeStep { Phase = phase, StartedAt = DateTime.UtcNow, Status = "InProgress" });
    }

    private static void CompleteStep(RdsUpgrade e, string phase, string status, string? message = null)
    {
        var step = e.Result!.StepHistory.LastOrDefault(s => s.Phase == phase && s.CompletedAt == null);
        if (step != null)
        {
            step.CompletedAt = DateTime.UtcNow;
            step.Status = status;
            step.Message = message;
        }
    }

    private static void AppendStep(RdsUpgrade e, string phase, string status, string? message = null)
    {
        e.Result!.StepHistory.Add(new RdsUpgradeStep
        {
            Phase = phase,
            StartedAt = DateTime.UtcNow,
            CompletedAt = DateTime.UtcNow,
            Status = status,
            Message = message,
        });
    }

    private static async Task PollUntilAsync(TimeSpan timeout, CancellationToken ct, Func<Task<bool>> conditionAsync, Func<string> waitingMessage)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (!await conditionAsync())
        {
            if (DateTime.UtcNow > deadline)
                throw new TimeoutException(waitingMessage());
            await Task.Delay(PollInterval, ct);
        }
    }

    private static string? ExtractIdentifierFromArn(string? arn)
    {
        if (string.IsNullOrEmpty(arn)) return arn;
        var lastColon = arn.LastIndexOf(':');
        return lastColon >= 0 ? arn.Substring(lastColon + 1) : arn;
    }

    // Extracts the leading integer from a version segment, e.g. "8.0.35" vs "8.4.0" — compares numerically
    // segment-by-segment so "8.4" > "8.0.35".
    internal static int CompareVersions(string a, string b)
    {
        var partsA = a.Split('.');
        var partsB = b.Split('.');
        var len = Math.Max(partsA.Length, partsB.Length);
        for (var i = 0; i < len; i++)
        {
            var diff = ParseVersionSegment(i < partsA.Length ? partsA[i] : null)
                     - ParseVersionSegment(i < partsB.Length ? partsB[i] : null);
            if (diff != 0) return diff;
        }
        return 0;
    }

    private static int ParseVersionSegment(string? segment)
    {
        if (string.IsNullOrEmpty(segment)) return 0;
        var digits = new string(segment.TakeWhile(char.IsDigit).ToArray());
        return digits.Length > 0 ? int.Parse(digits) : 0;
    }
}
