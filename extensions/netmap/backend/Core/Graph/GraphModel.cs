using System.Text.Json.Nodes;

namespace Duplo.Extension.NetMap.Core.Graph;

/// <summary>One cloud object, provider-neutral. Every collector writes this shape; the UI, the (v2) path engine
/// and the finding rules only ever read it. Persisted inside gzip JSON (never as BSON), so additive fields are
/// safe across extension versions.</summary>
public sealed class GraphNode
{
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Provider { get; set; } = "aws";
    public string? Account { get; set; }
    public string? Region { get; set; }
    public string NativeId { get; set; } = "";
    public string Name { get; set; } = "";
    public Dictionary<string, string> Tags { get; set; } = new();
    public List<string> Cidrs { get; set; } = new();
    public string? OwnerAccount { get; set; }
    public List<string> SeenFrom { get; set; } = new();
    public string Visibility { get; set; } = Visibilities.Full;
    public string Membership { get; set; } = Memberships.Blueprint;
    public string? ParentId { get; set; }
    public string? State { get; set; }
    public string? NativeState { get; set; }
    public Dictionary<string, JsonNode?> Attrs { get; set; } = new();
    public JsonObject? Raw { get; set; }
    public string CollectedBy { get; set; } = "";
    public DateTime CollectedAt { get; set; }
}

/// <summary>A configured relationship. v1 edges come only from configuration; observed traffic, if ever added,
/// is a separate layer.</summary>
public sealed class GraphEdge
{
    public string Id { get; set; } = "";
    public string From { get; set; } = "";
    public string To { get; set; } = "";
    public string Kind { get; set; } = "";
    public Dictionary<string, JsonNode?> Attrs { get; set; } = new();
}

public sealed class Finding
{
    public string RuleId { get; set; } = "";
    public string Severity { get; set; } = Severities.Warn;
    public List<string> NodeIds { get; set; } = new();
    public List<string> EdgeIds { get; set; } = new();
    public string Message { get; set; } = "";
}

/// <summary>What one work unit produces.</summary>
public sealed class GraphPart
{
    public List<GraphNode> Nodes { get; set; } = new();
    public List<GraphEdge> Edges { get; set; } = new();
    /// <summary>Non-fatal problems (an optional sub-fetch was denied or unavailable). Shown in the scan summary; they do not make a scan partial.</summary>
    public List<string> Warnings { get; set; } = new();
}

/// <summary>A finalized snapshot graph.</summary>
public sealed class NetworkGraph
{
    public int SchemaVersion { get; set; } = 1;
    public List<GraphNode> Nodes { get; set; } = new();
    public List<GraphEdge> Edges { get; set; } = new();
    public List<Finding> Findings { get; set; } = new();
}

public static class Visibilities
{
    public const string Full = "full";
    public const string Partial = "partial";
    public const string Stub = "stub";

    public static int Rank(string v) => v switch { Full => 2, Partial => 1, _ => 0 };
}

public static class Memberships
{
    public const string Blueprint = "blueprint";
    public const string Outside = "outside-blueprint";
}

public static class Severities
{
    public const string Ok = "ok";
    public const string Warn = "warn";
    public const string Bad = "bad";
}
