using System.Text.RegularExpressions;
using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.DataManagement.Services.Workers;
using Duplo.Ai.Model.Resource;
using Duplo.Ai.Studio.Extensibility.Infra;
using Duplo.Extension.NetMap.Core.Aws.Fetch;
using Duplo.Extension.NetMap.Core.Graph;
using Duplo.Extension.NetMap.Core.Scan;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Duplo.Extension.NetMap;

/// <summary>
/// Staged, resumable snapshot scans for NetworkBlueprint (pattern: CloudflareWatchWorker).
///   * ApplyAsync (create / spec edit): start a scan when it's the first, the members changed, or ScanRequestedAt
///     moved; a members change during a running scan queues one rescan; a ScanRequestedAt-only change while running
///     is ignored. Apply never collects: the drift ticks below do all AWS work.
///   * VerifyDriftAsync (every DriftCadence = 1 min on Complete rows): continue a running scan; otherwise return
///     immediately (no AWS calls). v4 adds scheduled scans here.
///   * Each tick runs work units within ScanEngine's 60 s budget and persists every unit; the last tick finalizes.
///   * Read-only: deletion removes this blueprint's snapshot rows and touches nothing in AWS.
/// </summary>
public class NetworkBlueprintWorker : ResourceWorkerBase<NetworkBlueprint, NetworkBlueprintSpec, NetworkBlueprintResult>
{
    public const int KeepFullSnapshots = 20;
    private static readonly Regex AwsAccount = new(@"^\d{12}$", RegexOptions.Compiled);

    public NetworkBlueprintWorker(IServiceScopeFactory scopeFactory, ILogger<NetworkBlueprintWorker> logger, IConfiguration? config = null)
        : base(scopeFactory, logger, config)
    {
    }

    protected override TimeSpan DriftCadence => TimeSpan.FromMinutes(1);

    protected override async Task ApplyAsync(NetworkBlueprint e, IServiceProvider scope, CancellationToken ct)
    {
        // Apply never collects: it only starts a scan or flags a queued rescan. The 1-minute drift ticks do all the
        // AWS work, so Apply stays far below the ~97 s worker tick timeout. A transient error is recorded, never thrown,
        // so it can't fail the row.
        try
        {
            var r = e.Result ??= new NetworkBlueprintResult();
            var spec = e.Spec ?? throw new InvalidOperationException("Blueprint has no spec.");
            var hash = BlueprintRules.MembersHash(spec.Members);

            if (r.ActiveScan is { } active)
            {
                // Editing the selection back to the scanned one clears the queued rescan.
                active.RescanQueued = active.MembersHash != hash;
                await SaveProgressAsync(scope, e, active.RescanQueued ? "Saved — rescan queued after the running scan" : "Saved — scan in progress", ct);
                return;
            }

            var wantsScan = r.LastSequence == 0 || r.LastMembersHash != hash || spec.ScanRequestedAt != r.LastScanRequestedAt;
            if (!wantsScan)
            {
                await SaveProgressAsync(scope, e, "Saved — network selection unchanged, no rescan", ct);
                return;
            }

            await StartScanAsync(e, scope, r.LastSequence == 0 ? "create" : "manual", ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            if (e.Result != null) e.Result.LastError = ex.Message;
            Logger.LogWarning(ex, "Network blueprint apply failed for {Id}", e.Id);
            await SaveProgressAsync(scope, e, $"Scan start failed: {ex.Message}", ct);
        }
    }

    protected override async Task VerifyDriftAsync(NetworkBlueprint e, IServiceProvider scope, CancellationToken ct)
    {
        var r = e.Result;
        if (r == null) return;
        try
        {
            if (r.ActiveScan != null)
            {
                await ContinueScanAsync(e, scope, ct);
            }
            else if (r.LastSequence > 0 && e.Spec != null && r.LastMembersHash != BlueprintRules.MembersHash(e.Spec.Members))
            {
                // Self-heal: a queued rescan can be lost (crash between clearing ActiveScan and starting the next scan).
                await StartScanAsync(e, scope, "manual", ct);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            r.LastError = ex.Message;
            Logger.LogWarning(ex, "Network blueprint scan tick failed for {Id}", e.Id);
            await SaveProgressAsync(scope, e, $"Scan tick failed: {ex.Message}", ct);
        }
    }

    protected override async Task DeleteSubResourcesAsync(NetworkBlueprint e, IServiceProvider scope, CancellationToken ct)
    {
        var repo = scope.GetRequiredService<IRepository<NetworkSnapshot>>();
        foreach (var s in await repo.GetAllAsync(x => x.Spec.BlueprintId == e.Id, ct))
            await repo.DeleteAsync(s.Id, ct);
    }

    protected override Task<bool> WaitForDeletionAsync(NetworkBlueprint e, IServiceProvider scope, CancellationToken ct) => Task.FromResult(true);

    private async Task StartScanAsync(NetworkBlueprint e, IServiceProvider scope, string trigger, CancellationToken ct)
    {
        var repo = scope.GetRequiredService<IRepository<NetworkSnapshot>>();
        var r = e.Result!;
        var spec = e.Spec!;
        var sequence = r.LastSequence + 1;
        var members = spec.Members.Select(m => new BlueprintMember { ScopeId = m.ScopeId, Provider = m.Provider, Region = m.Region, NetworkId = m.NetworkId, DisplayName = m.DisplayName, Cidrs = m.Cidrs?.ToList() ?? new() }).ToList();

        var snap = new NetworkSnapshot
        {
            Name = $"{e.Name}-scan-{sequence}",
            OwnerWorkspaceId = e.OwnerWorkspaceId,
            Status = ResourceStatus.Complete,
            Spec = new NetworkSnapshotSpec { BlueprintId = e.Id, Sequence = sequence, Trigger = trigger, Members = members, ScopeIds = spec.ScopeIds },
            Result = new NetworkSnapshotResult { ScanStatus = ScanStatuses.Running, StartedAt = DateTime.UtcNow, Units = ScanPlanner.Plan(members, Collectors.All) },
        };
        object? created = await repo.CreateAsync(snap, ct);   // object: CreateAsync's return type differs across SDK builds
        var snapshotId = (created as NetworkSnapshot)?.Id is { Length: > 0 } cid ? cid : snap.Id;

        r.LastSequence = sequence;
        r.LastError = null;
        r.ActiveScan = new ActiveScanInfo
        {
            SnapshotId = snapshotId, Sequence = sequence, RequestedAt = spec.ScanRequestedAt, StartedAt = snap.Result.StartedAt,
            MembersHash = BlueprintRules.MembersHash(members), UnitsTotal = snap.Result.Units.Count,
        };
        try
        {
            await SaveProgressAsync(scope, e, $"Scan #{sequence} started — {snap.Result.Units.Count} units", ct);
        }
        catch
        {
            // The blueprint never recorded this scan: remove the orphan snapshot (best effort) so it isn't left Running forever.
            r.ActiveScan = null;
            r.LastSequence = sequence - 1;
            try { await repo.DeleteAsync(snapshotId, CancellationToken.None); } catch (Exception dex) { Logger.LogWarning(dex, "Could not delete orphan snapshot {Id}", snapshotId); }
            throw;
        }
    }

    private async Task ContinueScanAsync(NetworkBlueprint e, IServiceProvider scope, CancellationToken ct)
    {
        var r = e.Result!;
        var active = r.ActiveScan!;
        var repo = scope.GetRequiredService<IRepository<NetworkSnapshot>>();
        var snap = await repo.GetByIdAsync(active.SnapshotId, ct);
        if (snap?.Result == null)
        {
            r.ActiveScan = null;
            await SaveProgressAsync(scope, e, "Active snapshot missing — scan abandoned", ct);
            return;
        }

        if (snap.Result.ScanStatus != ScanStatuses.Running)
        {
            // Already finalized by an interrupted tick (snapshot saved, blueprint save lost): adopt it, never re-finalize.
            await CompleteScanAsync(e, snap, scope, ct);
            return;
        }

        var (accounts, names) = await ScopeInfoAsync(scope, snap.Spec.Members, ct);
        var executor = new AwsUnitExecutor(scope.GetRequiredService<IScopeClientFactory>(), snap.Spec.Members, ScanAccounts.Fill(accounts, snap.Result.Units));
        var tick = await new ScanEngine().RunTickAsync(snap.Result.Units, executor, async unit =>
        {
            // spike2b: if consecutive UpdateAsync calls on one instance failed in Task 1, re-read here first.
            await repo.UpdateAsync(snap.Id, snap, ct);
            active.UnitsFinished = snap.Result.Units.Count(u => u.Status != UnitStatuses.Pending);
            active.CurrentUnit = unit.Id;
        }, ct);

        if (tick.Pending > 0)
        {
            await SaveProgressAsync(scope, e, $"Scanning {active.UnitsFinished}/{active.UnitsTotal} · {active.CurrentUnit}", ct);
            return;
        }

        await FinalizeAsync(e, snap, repo, ScanAccounts.Fill(accounts, snap.Result.Units), names, scope, ct);
    }

    private async Task FinalizeAsync(NetworkBlueprint e, NetworkSnapshot snap, IRepository<NetworkSnapshot> repo,
        IReadOnlyDictionary<string, string> accounts, IReadOnlyDictionary<string, string> names, IServiceProvider scope, CancellationToken ct)
    {
        var res = snap.Result!;
        var now = DateTime.UtcNow;

        try
        {
            var output = SnapshotFinalizer.Finalize(new FinalizeInput(snap.Spec.Members, res.Units, accounts, names, now));
            // Failed/Running snapshots carry no trustworthy hash, so they never count as "previous".
            var previous = (await repo.GetAllAsync(s => s.Spec.BlueprintId == e.Id && s.Id != snap.Id, ct))
                .Where(s => s.Result?.ContentHash != null && s.Result.ScanStatus != ScanStatuses.Failed && s.Result.ScanStatus != ScanStatuses.Running)
                .OrderByDescending(s => s.Spec.Sequence).FirstOrDefault();

            res.FinishedAt = now;
            res.ContentHash = output.ContentHash;
            res.Summary = output.Summary;
            res.MemberStatuses = output.MemberStatuses;
            if (previous?.Result?.ContentHash == output.ContentHash)
            {
                res.ScanStatus = ScanStatuses.Unchanged;
                res.SameAsSnapshotId = previous.Result.SameAsSnapshotId ?? previous.Id;
            }
            else
            {
                res.ScanStatus = output.ScanStatus;
                res.Graph = GraphCodec.Encode(output.Graph);
            }
            foreach (var u in res.Units) u.Part = null;
            await repo.UpdateAsync(snap.Id, snap, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // The blueprint keeps pointing at the previous good snapshot.
            res.ScanStatus = ScanStatuses.Failed;
            res.Error = ex.Message;
            res.FinishedAt = now;
            res.ContentHash = null;   // a failed row must never be matched as "unchanged"
            res.Graph = null;
            await repo.UpdateAsync(snap.Id, snap, ct);
            e.Result!.LastError = ex.Message;
            Logger.LogError(ex, "Finalizing snapshot {Snapshot} failed", snap.Id);
        }

        // Retention is housekeeping: its failure must not fail or redo the scan.
        try
        {
            await ApplyRetentionAsync(repo, e.Id, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Logger.LogWarning(ex, "Snapshot retention failed for {Id}", e.Id);
        }

        await CompleteScanAsync(e, snap, scope, ct);
    }

    /// <summary>Blueprint-side completion, shared by a fresh finalize and by adopting an already-finalized snapshot
    /// (idempotent: only copies from the persisted snapshot).</summary>
    private async Task CompleteScanAsync(NetworkBlueprint e, NetworkSnapshot snap, IServiceProvider scope, CancellationToken ct)
    {
        var r = e.Result!;
        var active = r.ActiveScan!;
        var res = snap.Result!;

        if (res.ScanStatus != ScanStatuses.Failed)
        {
            r.LatestSnapshotId = snap.Id;
            r.LatestSummary = res.Summary;
            r.MemberStatuses = res.MemberStatuses;
        }

        r.LastMembersHash = active.MembersHash;
        r.LastScanRequestedAt = e.Spec?.ScanRequestedAt;   // current spec value, so a bump during the scan isn't re-triggered
        var rescan = active.RescanQueued;
        r.ActiveScan = null;

        var s = r.LatestSummary;
        await SaveProgressAsync(scope, e, res.ScanStatus == ScanStatuses.Failed || s == null
            ? $"Scan #{snap.Spec.Sequence} {res.ScanStatus}"
            : $"Scan #{snap.Spec.Sequence} {res.ScanStatus} — {s.NodeCount} resources · {s.FindingsBad} critical · {s.FindingsWarn} warnings", ct);

        if (rescan)
        {
            await StartScanAsync(e, scope, "manual", ct);
        }
    }

    private static async Task ApplyRetentionAsync(IRepository<NetworkSnapshot> repo, string blueprintId, CancellationToken ct)
    {
        var withGraph = (await repo.GetAllAsync(s => s.Spec.BlueprintId == blueprintId, ct))
            .Where(s => s.Result?.Graph != null).OrderByDescending(s => s.Spec.Sequence).Skip(KeepFullSnapshots).ToList();
        foreach (var old in withGraph)
        {
            old.Result!.Graph = null;
            await repo.UpdateAsync(old.Id, old, ct);
        }
    }

    private static async Task<(Dictionary<string, string> Accounts, Dictionary<string, string> Names)> ScopeInfoAsync(
        IServiceProvider scope, IEnumerable<BlueprintMember> members, CancellationToken ct)
    {
        var accounts = new Dictionary<string, string>(StringComparer.Ordinal);
        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        var creds = scope.GetRequiredService<IScopeCredentials>();
        foreach (var s in await creds.ResolveAsync(members.Select(m => m.ScopeId).Distinct().ToList(), ct))
        {
            names[s.Scope.Id] = string.IsNullOrEmpty(s.Scope.Name) ? s.Scope.Id : s.Scope.Name;
            if (s.Provider.AccountId is { } a && AwsAccount.IsMatch(a)) accounts[s.Scope.Id] = a;
        }
        return (accounts, names);
    }
}
