using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.NetworkStack;

/// <summary>
/// The on-demand action the user most recently requested via the detail view's Plan/Apply buttons.
/// Stored on the resource's Spec: stamping it and calling UpdateAsync makes the platform message the
/// resource's SAME long-lived ticket, where the provisioning skill dispatches on the verb
/// (see skills/provision-network-stack/SKILL.md).
/// </summary>
public class NetworkStackRequestedAction
{
    /// <summary>plan | apply.</summary>
    [BsonElement("action")] public string Action { get; set; } = "";

    /// <summary>UTC time the action was requested (monotonic).</summary>
    [BsonElement("requestedAt")] public DateTime RequestedAt { get; set; }

    /// <summary>Who pressed the button — stamped from the caller's JWT. The skill copies it onto the
    /// run's history entry; a run has no other notion of a user.</summary>
    [BsonElement("requestedBy")] public string? RequestedBy { get; set; }
}

/// <summary>
/// One persisted history entry for a run (initial provision, plan, or apply) — appended to
/// <c>Result.Actions[]</c> by the skill after each run.
/// </summary>
public class NetworkStackActionHistoryEntry
{
    [BsonElement("action")] public string Action { get; set; } = "";
    [BsonElement("requestedAt")] public DateTime RequestedAt { get; set; }
    [BsonElement("requestedBy")] public string? RequestedBy { get; set; }
    [BsonElement("startedAt")] public DateTime? StartedAt { get; set; }
    [BsonElement("finishedAt")] public DateTime? FinishedAt { get; set; }
    /// <summary>Complete | Failed | Running.</summary>
    [BsonElement("status")] public string Status { get; set; } = "";
    [BsonElement("summary")] public string? Summary { get; set; }
    /// <summary>UUID linking to the run's log/meta files (canvas-documents/{plans,applies}/&lt;runId&gt;.*).</summary>
    [BsonElement("runId")] public string? RunId { get; set; }
    /// <summary>plan only: whether the plan reported changes.</summary>
    [BsonElement("hasDiff")] public bool? HasDiff { get; set; }
}

/// <summary>One provisioning module's live status — the skill posts these progressively during a run.</summary>
public class NetworkStackModule
{
    /// <summary>vpc | subnets | security.</summary>
    [BsonElement("key")] public string Key { get; set; } = "";
    [BsonElement("label")] public string Label { get; set; } = "";
    /// <summary>NotStarted | Creating | Created | Failed | Destroying | Destroyed.</summary>
    [BsonElement("status")] public string Status { get; set; } = "";
}

/// <summary>
/// Per-run metadata the skill writes to <c>canvas-documents/{plans,applies}/&lt;runId&gt;.meta.json</c>
/// in the ticket workdir; the backend reads it back via <c>ITicketService</c> for the Logs tab.
/// Property names are case-insensitive on deserialize, matching the skill's lowercase JSON keys.
/// </summary>
public class NetworkStackRunMeta
{
    public string RunId { get; set; } = "";
    public DateTime RanAt { get; set; }
    public bool Running { get; set; }
    public bool Success { get; set; }
    public bool HasDiff { get; set; }
    public string? Summary { get; set; }
    public string? Verb { get; set; }
}

/// <summary>Response bundle for one run — meta + the raw ANSI-colored terraform log.</summary>
public class NetworkStackRunDetail
{
    public NetworkStackRunMeta Meta { get; set; } = new();
    public string Log { get; set; } = "";
}

/// <summary>One live subnet row, injected (never persisted) by EnrichResultAsync on GET.</summary>
public class NetworkStackLiveSubnet
{
    public string? SubnetId { get; set; }
    public string? Cidr { get; set; }
    public string? AvailabilityZone { get; set; }
    public string? State { get; set; }
    public int? AvailableIps { get; set; }
}
