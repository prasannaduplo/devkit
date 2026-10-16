using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.NetMap.Core.Scan;

// These types are persisted as BSON on the blueprint / snapshot documents. [BsonIgnoreExtraElements] on every one
// keeps schema changes additive-only: an older active extension version can still read documents a newer one wrote.

[BsonIgnoreExtraElements]
public sealed class BlueprintMember
{
    public string ScopeId { get; set; } = "";
    public string Provider { get; set; } = "aws";
    public string Region { get; set; } = "";
    public string NetworkId { get; set; } = "";
    public string? DisplayName { get; set; }
    public List<string> Cidrs { get; set; } = new();
}

public static class UnitStatuses
{
    public const string Pending = "pending";
    public const string Done = "done";
    public const string Failed = "failed";
    public const string Denied = "denied";
}

[BsonIgnoreExtraElements]
public sealed class WorkUnit
{
    public string Id { get; set; } = "";
    public string Collector { get; set; } = "";
    public string ScopeId { get; set; } = "";
    public string Region { get; set; } = "";
    public int Order { get; set; }
    public string Status { get; set; } = UnitStatuses.Pending;
    public int Attempts { get; set; }
    public string? Error { get; set; }
    public string? MissingPermission { get; set; }
    public DateTime? CollectedAt { get; set; }
    public byte[]? Part { get; set; }
}

public static class ScanStatuses
{
    public const string Running = "running";
    public const string Complete = "complete";
    public const string Partial = "partial";
    public const string Failed = "failed";
    public const string Unchanged = "unchanged";
}

[BsonIgnoreExtraElements]
public sealed class ActiveScanInfo
{
    public string SnapshotId { get; set; } = "";
    public int Sequence { get; set; }
    public DateTime? RequestedAt { get; set; }
    public DateTime StartedAt { get; set; }
    public string MembersHash { get; set; } = "";
    public int UnitsTotal { get; set; }
    public int UnitsFinished { get; set; }
    public string? CurrentUnit { get; set; }
    public bool RescanQueued { get; set; }
}

public static class CapabilityStates
{
    public const string Available = "available";
    public const string Partial = "partial";
    public const string NotReadable = "not-readable";
    public const string None = "none";
}

[BsonIgnoreExtraElements]
public sealed class CapabilityState
{
    public string State { get; set; } = CapabilityStates.None;
    public string Reason { get; set; } = "";
    public Dictionary<string, int> Counts { get; set; } = new();
}

[BsonIgnoreExtraElements]
public sealed class SnapshotSummary
{
    public string Status { get; set; } = ScanStatuses.Running;
    public DateTime FinishedAt { get; set; }
    public int NodeCount { get; set; }
    public int StubCount { get; set; }
    public int EdgeCount { get; set; }
    public Dictionary<string, int> KindCounts { get; set; } = new();
    public Dictionary<string, CapabilityState> Capabilities { get; set; } = new();
    public int FindingsBad { get; set; }
    public int FindingsWarn { get; set; }
    public int UnitsTotal { get; set; }
    public int UnitsDone { get; set; }
    public int UnitsFailed { get; set; }
    public int UnitsDenied { get; set; }
    public List<string> UnitProblems { get; set; } = new();
}

public static class MemberStates
{
    public const string Ok = "ok";
    public const string Missing = "missing";
    public const string ScopeError = "scope-error";
}

[BsonIgnoreExtraElements]
public sealed class MemberStatus
{
    public string ScopeId { get; set; } = "";
    public string Region { get; set; } = "";
    public string NetworkId { get; set; } = "";
    public string Status { get; set; } = MemberStates.Ok;
    public string? DisplayName { get; set; }
    public List<string> Cidrs { get; set; } = new();
    public string? Message { get; set; }
}
