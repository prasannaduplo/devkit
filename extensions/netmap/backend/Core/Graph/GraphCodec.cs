using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Duplo.Extension.NetMap.Core.Graph;

/// <summary>gzip(JSON) for work-unit parts and finalized graphs (~10× smaller than raw JSON, which keeps a
/// snapshot far below Mongo's 16 MB document limit), plus a content hash that ignores fields that change on every
/// scan without the network changing.</summary>
public static class GraphCodec
{
    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static byte[] Encode<T>(T value)
    {
        using var ms = new MemoryStream();
        using (var gz = new GZipStream(ms, CompressionLevel.Optimal, leaveOpen: true))
            JsonSerializer.Serialize(gz, value, Json);
        return ms.ToArray();
    }

    public static T Decode<T>(byte[] data)
    {
        using var gz = new GZipStream(new MemoryStream(data), CompressionMode.Decompress);
        return JsonSerializer.Deserialize<T>(gz, Json) ?? throw new InvalidDataException("Empty graph payload.");
    }

    public static string ToJson<T>(T value) => JsonSerializer.Serialize(value, Json);

    public static string ContentHash(NetworkGraph graph)
    {
        var canonical = new NetworkGraph
        {
            SchemaVersion = graph.SchemaVersion,
            Nodes = graph.Nodes.OrderBy(n => n.Id, StringComparer.Ordinal).Select(Canonical).ToList(),
            Edges = graph.Edges.OrderBy(e => e.Id, StringComparer.Ordinal).Select(CanonicalEdge).ToList(),
            Findings = graph.Findings.OrderBy(f => f.RuleId, StringComparer.Ordinal)
                .ThenBy(f => string.Join(",", f.NodeIds.OrderBy(x => x, StringComparer.Ordinal)), StringComparer.Ordinal)
                .Select(CanonicalFinding).ToList(),
        };
        return Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(canonical, Json))).ToLowerInvariant();
    }

    private static GraphNode Canonical(GraphNode n)
    {
        var c = JsonSerializer.Deserialize<GraphNode>(JsonSerializer.Serialize(n, Json), Json)!;
        c.CollectedAt = default;
        c.SeenFrom.Sort(StringComparer.Ordinal);
        c.Cidrs.Sort(StringComparer.Ordinal);
        c.Raw = SortKeys(c.Raw) as JsonObject;  // hash-only: arrays are unordered
        c.Tags = c.Tags.OrderBy(kv => kv.Key, StringComparer.Ordinal).ToDictionary(kv => kv.Key, kv => kv.Value);
        c.Attrs = SortedAttrs(c.Attrs);
        return c;
    }

    private static GraphEdge CanonicalEdge(GraphEdge e) => new()
    {
        Id = e.Id, From = e.From, To = e.To, Kind = e.Kind, Attrs = SortedAttrs(e.Attrs),
    };

    private static Finding CanonicalFinding(Finding f) => new()
    {
        RuleId = f.RuleId, Severity = f.Severity, Message = f.Message,
        NodeIds = f.NodeIds.OrderBy(x => x, StringComparer.Ordinal).ToList(),
        EdgeIds = f.EdgeIds.OrderBy(x => x, StringComparer.Ordinal).ToList(),
    };

    private static Dictionary<string, JsonNode?> SortedAttrs(Dictionary<string, JsonNode?> attrs) =>
        attrs.OrderBy(kv => kv.Key, StringComparer.Ordinal).ToDictionary(kv => kv.Key, kv => SortKeys(kv.Value));

    /// <summary>Hash canonicalization: deep copy with every object's properties in ordinal key order and every array's elements
/// sorted by their canonical JSON (AWS returns some lists in nondeterministic order). Never used for stored output.</summary>
    private static JsonNode? SortKeys(JsonNode? n)
    {
        switch (n)
        {
            case JsonObject o:
                var r = new JsonObject();
                foreach (var kv in o.OrderBy(kv => kv.Key, StringComparer.Ordinal)) r.Add(kv.Key, SortKeys(kv.Value));
                return r;
            case JsonArray a:
                var ra = new JsonArray();
                foreach (var e in a.Select(SortKeys).OrderBy(x => x?.ToJsonString() ?? "null", StringComparer.Ordinal)) ra.Add(e);
                return ra;
            case null:
                return null;
            default:
                return n.DeepClone();
        }
    }
}
