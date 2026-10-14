using System.Text.Json.Serialization;
using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.Cloudflare.Cf;

// Wire types for the Cloudflare v4 REST API plus the persisted state the watch keeps in its Result.
// Nothing in this folder touches the Duplo SDK, so tests/ compiles it directly (linked files) and runs it
// without the host's assemblies.

/// <summary>The v4 envelope every endpoint wraps its payload in.</summary>
public sealed class CfEnvelope<T>
{
    [JsonPropertyName("success")] public bool Success { get; set; }
    [JsonPropertyName("errors")] public List<CfMessage>? Errors { get; set; }
    [JsonPropertyName("result")] public T? Result { get; set; }
    [JsonPropertyName("result_info")] public CfResultInfo? ResultInfo { get; set; }
}

public sealed class CfMessage
{
    [JsonPropertyName("code")] public int Code { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
}

public sealed class CfResultInfo
{
    [JsonPropertyName("page")] public int Page { get; set; }
    [JsonPropertyName("per_page")] public int PerPage { get; set; }
    [JsonPropertyName("total_pages")] public int? TotalPages { get; set; }
    [JsonPropertyName("total_count")] public int? TotalCount { get; set; }
}

/// <summary><c>GET /accounts/{id}/tokens/verify</c>.</summary>
public sealed class CfTokenVerify
{
    [JsonPropertyName("id")] public string? Id { get; set; }
    [JsonPropertyName("status")] public string? Status { get; set; }
    [JsonPropertyName("expires_on")] public DateTime? ExpiresOn { get; set; }
    /// <summary>Start of the token's TTL. Cloudflare still reports <c>status: active</c> before it, but rejects calls.</summary>
    [JsonPropertyName("not_before")] public DateTime? NotBefore { get; set; }

    /// <summary>Why this token can't be used right now, or null when it can.</summary>
    public string? UnusableReason(DateTime nowUtc)
    {
        if (!string.Equals(Status, "active", StringComparison.OrdinalIgnoreCase))
            return $"The Cloudflare API token is '{Status ?? "unknown"}', not active — replace it on the scope.";
        if (NotBefore is { } nb && nb.ToUniversalTime() > nowUtc)
            return $"The Cloudflare API token is not valid until {nb.ToUniversalTime():yyyy-MM-dd HH:mm} UTC (its TTL start date) — " +
                   "recreate it with no start date or one in the past.";
        if (ExpiresOn is { } ex && ex.ToUniversalTime() <= nowUtc)
            return $"The Cloudflare API token expired at {ex.ToUniversalTime():yyyy-MM-dd HH:mm} UTC — replace it on the scope.";
        return null;
    }
}

/// <summary>One entry of <c>GET /accounts/{id}/workers/scripts</c>; <c>id</c> is the script name.</summary>
public sealed class CfScript
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("created_on")] public DateTime? CreatedOn { get; set; }
    [JsonPropertyName("modified_on")] public DateTime? ModifiedOn { get; set; }
}

/// <summary><c>GET /accounts/{id}/workers/scripts/{name}/deployments</c> — newest first.</summary>
public sealed class CfDeploymentList
{
    [JsonPropertyName("deployments")] public List<CfDeployment>? Deployments { get; set; }
}

public sealed class CfDeployment
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("created_on")] public DateTime? CreatedOn { get; set; }
    [JsonPropertyName("source")] public string? Source { get; set; }
    [JsonPropertyName("strategy")] public string? Strategy { get; set; }
    [JsonPropertyName("author_email")] public string? AuthorEmail { get; set; }
    [JsonPropertyName("annotations")] public Dictionary<string, string>? Annotations { get; set; }
    [JsonPropertyName("versions")] public List<CfDeploymentVersion>? Versions { get; set; }

    public string? Annotation(string key) =>
        Annotations != null && Annotations.TryGetValue(key, out var v) && !string.IsNullOrWhiteSpace(v) ? v : null;
}

public sealed class CfDeploymentVersion
{
    [JsonPropertyName("version_id")] public string? VersionId { get; set; }
    [JsonPropertyName("percentage")] public double? Percentage { get; set; }
}

// ---- persisted state (lives in CloudflareWatchResult) ----

/// <summary>What the watch last saw for one Worker script.</summary>
[BsonIgnoreExtraElements]
public sealed class WorkerScriptState
{
    public string Name { get; set; } = "";
    public DateTime? CreatedOn { get; set; }
    /// <summary>The script's <c>modified_on</c> as of the last deployments fetch — a change triggers a re-fetch.</summary>
    public DateTime? ModifiedOn { get; set; }
    public string? CurrentDeploymentId { get; set; }
    public List<string> CurrentVersionIds { get; set; } = new();
    public DateTime? LastDeployedAt { get; set; }
    public string? LastDeployedBy { get; set; }
    public string? LastDeploySource { get; set; }
    public string? LastDeployMessage { get; set; }
}

public static class WorkerEventKinds
{
    public const string ScriptAdded = "ScriptAdded";
    public const string ScriptDeleted = "ScriptDeleted";
    public const string Deployed = "Deployed";
}

/// <summary>One change the watch detected — append-only, newest first, capped at the spec's history limit.</summary>
[BsonIgnoreExtraElements]
public sealed class WorkerEvent
{
    public DateTime At { get; set; }
    public string Kind { get; set; } = "";
    public string Script { get; set; } = "";
    public string? DeploymentId { get; set; }
    public List<string> VersionIds { get; set; } = new();
    public string? Author { get; set; }
    public string? Source { get; set; }
    public string? Message { get; set; }
}

[BsonIgnoreExtraElements]
public sealed class WorkerEventCounts
{
    public int Added { get; set; }
    public int Deleted { get; set; }
    public int Deployed { get; set; }
}
