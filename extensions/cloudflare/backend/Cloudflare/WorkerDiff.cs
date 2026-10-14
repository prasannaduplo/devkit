using System.Text.RegularExpressions;

namespace Duplo.Extension.Cloudflare.Cf;

/// <summary>Output of one scan: the new per-script state plus the events it produced (newest first).</summary>
public sealed record ScanOutcome(List<WorkerScriptState> Scripts, List<WorkerEvent> Events);

/// <summary>
/// The watch's pure core: decide which scripts need a deployments fetch, then turn
/// (previous state, current inventory, fetched deployments) into new state + events. No I/O, no clock reads.
///
/// Rules:
///  * baseline scan → state only, no events (pre-existing Workers are not "changes");
///  * script present now but not before → ScriptAdded (carrying its live deployment, if fetched);
///  * script present before but not now → ScriptDeleted;
///  * script whose fetched deployments include ones newer than what we recorded → one Deployed event each,
///    so two deploys inside one poll window both show up;
///  * a changed script whose deployments were NOT fetched this tick (fetch cap) keeps its old ModifiedOn, so
///    it is picked up again next tick instead of being silently marked current.
/// </summary>
public static class WorkerDiff
{
    public const string TriggeredByAnnotation = "workers/triggered_by";
    public const string MessageAnnotation = "workers/message";
    /// <summary>Upper bound on Deployed events per script per scan (the deployments endpoint is newest-first).</summary>
    public const int DeployedEventsPerScriptCap = 10;

    public static List<CfScript> Filter(IEnumerable<CfScript> scripts, string? glob)
    {
        if (string.IsNullOrWhiteSpace(glob)) return scripts.ToList();
        var patterns = glob.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(g => new Regex("^" + Regex.Escape(g).Replace("\\*", ".*").Replace("\\?", ".") + "$",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            .ToList();
        return scripts.Where(s => patterns.Any(p => p.IsMatch(s.Id))).ToList();
    }

    /// <summary>Scripts that are new or whose <c>modified_on</c> moved since the last fetch, capped (oldest change first).</summary>
    public static List<string> NeedingDeployments(
        IReadOnlyCollection<WorkerScriptState>? previous, IEnumerable<CfScript> current, int cap)
    {
        var prev = (previous ?? Array.Empty<WorkerScriptState>()).ToDictionary(s => s.Name, StringComparer.Ordinal);
        return current
            .Where(s => !prev.TryGetValue(s.Id, out var p) || p.ModifiedOn != s.ModifiedOn || p.CurrentDeploymentId == null)
            .OrderBy(s => s.ModifiedOn ?? DateTime.MinValue)
            .Select(s => s.Id)
            .Take(Math.Max(0, cap))
            .ToList();
    }

    public static ScanOutcome Apply(
        IReadOnlyCollection<WorkerScriptState>? previous,
        IEnumerable<CfScript> current,
        IReadOnlyDictionary<string, List<CfDeployment>> fetched,
        DateTime nowUtc,
        bool baseline)
    {
        var prev = (previous ?? Array.Empty<WorkerScriptState>()).ToDictionary(s => s.Name, StringComparer.Ordinal);
        var currentList = current.ToList();
        var scripts = new List<WorkerScriptState>();
        var events = new List<WorkerEvent>();

        foreach (var s in currentList.OrderBy(s => s.Id, StringComparer.Ordinal))
        {
            prev.TryGetValue(s.Id, out var old);
            fetched.TryGetValue(s.Id, out var deps);
            var live = deps?.FirstOrDefault();

            var state = old == null ? new WorkerScriptState { Name = s.Id } : Clone(old);
            state.CreatedOn = s.CreatedOn;
            if (deps != null)
            {
                state.ModifiedOn = s.ModifiedOn;   // only advance once we've actually looked at deployments
                if (live != null) SetLive(state, live);
            }
            else if (old == null)
            {
                state.ModifiedOn = null;           // new but unfetched → NeedingDeployments picks it up next tick
            }
            scripts.Add(state);

            if (baseline) continue;

            if (old == null)
            {
                events.Add(Event(WorkerEventKinds.ScriptAdded, s.Id, live, live?.CreatedOn ?? s.CreatedOn ?? nowUtc));
            }
            else if (deps != null && old.CurrentDeploymentId != null)
            {
                // (CurrentDeploymentId == null means we never saw its live deployment — e.g. it was added while the
                // fetch cap was hit — so this fetch only establishes state; replaying its history would be noise.)
                // Deployments we haven't recorded yet: newer than the last one we knew, excluding it by id.
                var newer = deps
                    .Where(d => d.Id != old.CurrentDeploymentId
                                && (old.LastDeployedAt == null || (d.CreatedOn ?? nowUtc) > old.LastDeployedAt))
                    .Take(DeployedEventsPerScriptCap)
                    .OrderBy(d => d.CreatedOn ?? nowUtc);
                foreach (var d in newer)
                    events.Add(Event(WorkerEventKinds.Deployed, s.Id, d, d.CreatedOn ?? nowUtc));
            }
        }

        if (!baseline)
        {
            var currentNames = new HashSet<string>(currentList.Select(s => s.Id), StringComparer.Ordinal);
            foreach (var gone in prev.Values.Where(p => !currentNames.Contains(p.Name)).OrderBy(p => p.Name, StringComparer.Ordinal))
                events.Add(new WorkerEvent
                {
                    At = nowUtc, Kind = WorkerEventKinds.ScriptDeleted, Script = gone.Name,
                    DeploymentId = gone.CurrentDeploymentId, VersionIds = gone.CurrentVersionIds.ToList(),
                });
        }

        return new ScanOutcome(scripts, events.OrderByDescending(e => e.At).ToList());
    }

    /// <summary>New events in front of the history, trimmed to <paramref name="limit"/>.</summary>
    public static List<WorkerEvent> AppendHistory(IEnumerable<WorkerEvent>? history, IEnumerable<WorkerEvent> newest, int limit)
        => newest.Concat(history ?? Enumerable.Empty<WorkerEvent>()).Take(Math.Max(1, limit)).ToList();

    public static void Count(WorkerEventCounts counts, IEnumerable<WorkerEvent> events)
    {
        foreach (var e in events)
        {
            if (e.Kind == WorkerEventKinds.ScriptAdded) counts.Added++;
            else if (e.Kind == WorkerEventKinds.ScriptDeleted) counts.Deleted++;
            else if (e.Kind == WorkerEventKinds.Deployed) counts.Deployed++;
        }
    }

    private static void SetLive(WorkerScriptState st, CfDeployment d)
    {
        st.CurrentDeploymentId = d.Id;
        st.CurrentVersionIds = VersionIds(d);
        st.LastDeployedAt = d.CreatedOn;
        st.LastDeployedBy = Author(d);
        st.LastDeploySource = d.Source;
        st.LastDeployMessage = d.Annotation(MessageAnnotation);
    }

    private static WorkerEvent Event(string kind, string script, CfDeployment? d, DateTime at) => new()
    {
        At = at, Kind = kind, Script = script,
        DeploymentId = d?.Id,
        VersionIds = d == null ? new List<string>() : VersionIds(d),
        Author = d == null ? null : Author(d),
        Source = d?.Source,
        Message = d?.Annotation(MessageAnnotation),
    };

    private static string? Author(CfDeployment d) => d.AuthorEmail ?? d.Annotation(TriggeredByAnnotation);

    private static List<string> VersionIds(CfDeployment d) =>
        (d.Versions ?? new List<CfDeploymentVersion>()).Select(v => v.VersionId).OfType<string>().ToList();

    private static WorkerScriptState Clone(WorkerScriptState s) => new()
    {
        Name = s.Name, CreatedOn = s.CreatedOn, ModifiedOn = s.ModifiedOn,
        CurrentDeploymentId = s.CurrentDeploymentId, CurrentVersionIds = s.CurrentVersionIds.ToList(),
        LastDeployedAt = s.LastDeployedAt, LastDeployedBy = s.LastDeployedBy,
        LastDeploySource = s.LastDeploySource, LastDeployMessage = s.LastDeployMessage,
    };
}
