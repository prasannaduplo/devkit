using Duplo.Extension.NetMap.Core.Graph;

namespace Duplo.Extension.NetMap.Core.Scan;

public interface IUnitExecutor
{
    Task<GraphPart> ExecuteAsync(WorkUnit unit, IReadOnlyList<GraphPart> priors, CancellationToken ct);
}

public sealed record TickResult(int Executed, int Pending, bool BudgetExhausted);

/// <summary>Runs pending work units in list order until the tick budget is spent. A unit only starts while the
/// elapsed time is under Budget (60 s); each unit is hard-capped so the tick ends before the platform's ~97 s worker
/// cancellation. Every finished unit is persisted immediately, so a host restart loses at most the in-flight one.</summary>
public sealed class ScanEngine
{
    public const int MaxAttempts = 3;
    public TimeSpan Budget { get; init; } = TimeSpan.FromSeconds(60);
    public TimeSpan HardCap { get; init; } = TimeSpan.FromSeconds(85);

    private readonly Func<DateTime> _clock;

    public ScanEngine(Func<DateTime>? clock = null) => _clock = clock ?? (() => DateTime.UtcNow);

    public async Task<TickResult> RunTickAsync(List<WorkUnit> units, IUnitExecutor executor, Func<WorkUnit, Task> persist, CancellationToken ct)
    {
        var start = _clock();
        var executed = 0;
        var exhausted = false;

        foreach (var unit in units.Where(u => u.Status == UnitStatuses.Pending).ToList())
        {
            ct.ThrowIfCancellationRequested();
            var elapsed = _clock() - start;
            if (elapsed >= Budget) { exhausted = true; break; }

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var cap = HardCap - elapsed;
            cts.CancelAfter(cap > TimeSpan.Zero ? cap : TimeSpan.FromSeconds(1));
            try
            {
                var part = await executor.ExecuteAsync(unit, PriorsFor(unit, units), cts.Token).WaitAsync(cts.Token);
                unit.Part = GraphCodec.Encode(part);
                unit.Status = UnitStatuses.Done;
                unit.Error = null;
                unit.CollectedAt = _clock();
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                var timedOut = ex is OperationCanceledException && cts.IsCancellationRequested;
                if (timedOut && executed > 0)
                {
                    // Started after another unit in this tick, so its cap was shortened: retry with a full cap next tick.
                    // The first unit of a tick always gets the full cap and consumes an attempt, guaranteeing progress.
                    unit.Error = $"timed out after {cap.TotalSeconds:0}s (started late in tick; retrying with full budget)";
                    executed++;
                    await persist(unit);
                    continue;
                }
                unit.Attempts++;
                var (kind, permission) = ErrorClassifier.Classify(ex);
                unit.Error = ex is OperationCanceledException ? $"timed out after {cap.TotalSeconds:0}s" : ex.Message;
                if (kind == ErrorKind.Denied)
                {
                    unit.Status = UnitStatuses.Denied;
                    unit.MissingPermission = permission;
                }
                else if (unit.Attempts >= MaxAttempts)
                {
                    unit.Status = UnitStatuses.Failed;
                }
            }

            executed++;
            await persist(unit);
        }

        return new TickResult(executed, units.Count(u => u.Status == UnitStatuses.Pending), exhausted);
    }

    /// <summary>Earlier finished parts a unit may build on: same scope, and same region unless the unit is global.</summary>
    public static IReadOnlyList<GraphPart> PriorsFor(WorkUnit unit, IEnumerable<WorkUnit> all) =>
        all.Where(u => !ReferenceEquals(u, unit) && u.Status == UnitStatuses.Done && u.Part != null && u.ScopeId == unit.ScopeId
                       && (unit.Region == ScanPlanner.GlobalRegion || u.Region == unit.Region))
           .Select(u => GraphCodec.Decode<GraphPart>(u.Part!))
           .ToList();
}
