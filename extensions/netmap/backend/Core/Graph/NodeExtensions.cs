using System.Text.Json.Nodes;

namespace Duplo.Extension.NetMap.Core.Graph;

public static class NodeExtensions
{
    /// <summary>Copies tags; a non-empty "Name" tag becomes the display name (it beats any fallback name).</summary>
    public static GraphNode Tagged(this GraphNode n, IEnumerable<KeyValuePair<string, string>> tags)
    {
        foreach (var (k, v) in tags) n.Tags[k] = v;
        if (n.Tags.TryGetValue("Name", out var name) && !string.IsNullOrWhiteSpace(name)) n.Name = name;
        return n;
    }

    /// <summary>Fallback display name, used only while the node still shows its raw native id. Call before Tagged.</summary>
    public static GraphNode Named(this GraphNode n, string? name)
    {
        if (!string.IsNullOrWhiteSpace(name) && (string.IsNullOrEmpty(n.Name) || n.Name == n.NativeId)) n.Name = name;
        return n;
    }

    public static GraphNode Under(this GraphNode n, string? parentId)
    {
        n.ParentId = parentId;
        return n;
    }

    public static GraphNode SetState(this GraphNode n, string? native)
    {
        n.NativeState = native;
        n.State = States.Normalize(native);
        return n;
    }

    public static GraphNode AsStub(this GraphNode n)
    {
        n.Visibility = Visibilities.Stub;
        n.Membership = Memberships.Outside;
        return n;
    }

    public static GraphNode Attr(this GraphNode n, string key, JsonNode? value)
    {
        if (value is not null) n.Attrs[key] = value;
        return n;
    }

    public static GraphEdge Attr(this GraphEdge e, string key, JsonNode? value)
    {
        if (value is not null) e.Attrs[key] = value;
        return e;
    }

    public static string? AttrString(this GraphNode n, string key) => Str(n.Attrs, key);
    public static string? AttrString(this GraphEdge e, string key) => Str(e.Attrs, key);
    public static int? AttrInt(this GraphNode n, string key) =>
        n.Attrs.TryGetValue(key, out var v) && v is JsonValue jv && jv.TryGetValue<int>(out var i) ? i : null;
    public static bool? AttrBool(this GraphNode n, string key) =>
        n.Attrs.TryGetValue(key, out var v) && v is JsonValue jv && jv.TryGetValue<bool>(out var b) ? b : null;

    public static IEnumerable<string> AttrStrings(this GraphNode n, string key) =>
        n.Attrs.TryGetValue(key, out var v) && v is JsonArray a
            ? a.OfType<JsonValue>().Select(x => x.TryGetValue<string>(out var s) ? s : null).OfType<string>()
            : Enumerable.Empty<string>();

    public static JsonArray Arr(IEnumerable<string?> items) =>
        new(items.Where(i => i != null).Select(i => (JsonNode?)JsonValue.Create(i)).ToArray());

    private static string? Str(Dictionary<string, JsonNode?> attrs, string key) =>
        attrs.TryGetValue(key, out var v) && v is JsonValue jv && jv.TryGetValue<string>(out var s) ? s : null;
}

/// <summary>Native state strings → a small normalized set. The native value is always kept beside it.</summary>
public static class States
{
    public static string? Normalize(string? native)
    {
        if (string.IsNullOrEmpty(native)) return null;
        var s = native.ToLowerInvariant();
        return s switch
        {
            "available" or "attached" or "active" or "associated" or "running" or "provisioned" or "in-use" => "available",
            "up" => "up",
            "down" => "down",
            "deleted" or "deleting" or "detached" or "detaching" or "terminated" => "deleted",
            "failed" or "rejected" or "expired" or "failing" => "failed",
            _ when s.StartsWith("pending") || s is "attaching" or "provisioning" or "initiating" or "initiating-request" or "modifying" or "creating" => "pending",
            _ => s,
        };
    }
}
