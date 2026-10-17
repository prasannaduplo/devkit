using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;

namespace Duplo.Extension.NetMap.Core.Graph;

/// <summary>Shapes a stored graph for the wire. The platform proxy does not gzip responses and node <c>raw</c>
/// (sanitized AWS JSON) is over half of the bytes, while the UI only needs it for the path engine (network ACL
/// entries, security-group permission presence) and, lazily, for the side panel's Raw section.</summary>
public static class GraphTransfer
{
    public const string RawAll = "all";
    public const string RawRouting = "routing";
    public const string RawNone = "none";

    public const string EncodingJson = "json";
    public const string EncodingGzip64 = "gzip64";
    /// <summary>Value of the <c>encoding</c> field in a gzip64 response body.</summary>
    public const string GzipBase64 = "gzip-base64";

    /// <summary>Node kinds whose <c>raw</c> the path engine reads.</summary>
    public static readonly IReadOnlySet<string> RoutingRawKinds = new HashSet<string>(StringComparer.Ordinal)
    {
        NodeKinds.Nacl, NodeKinds.SecurityGroup,
    };

    /// <summary>Normalizes the <c>raw=</c> query value (null/empty = all). Throws ArgumentException when unknown.</summary>
    public static string ParseRawMode(string? raw) => (raw ?? "").Trim().ToLowerInvariant() switch
    {
        "" or RawAll => RawAll,
        RawRouting => RawRouting,
        RawNone => RawNone,
        var other => throw new ArgumentException($"Unknown raw mode '{other}' (expected none, routing or all)."),
    };

    /// <summary>Normalizes the <c>encoding=</c> query value (null/empty = json). Throws ArgumentException when unknown.</summary>
    public static string ParseEncoding(string? encoding) => (encoding ?? "").Trim().ToLowerInvariant() switch
    {
        "" or EncodingJson => EncodingJson,
        EncodingGzip64 => EncodingGzip64,
        var other => throw new ArgumentException($"Unknown encoding '{other}' (expected json or gzip64)."),
    };

    /// <summary>Drops <c>raw</c> in place according to the mode (graph is a freshly decoded copy).</summary>
    public static NetworkGraph FilterRaw(NetworkGraph graph, string rawMode)
    {
        if (rawMode == RawAll) return graph;
        foreach (var n in graph.Nodes)
            if (rawMode == RawNone || !RoutingRawKinds.Contains(n.Kind)) n.Raw = null;
        return graph;
    }

    /// <summary>The graph JSON exactly as the plain endpoint serializes it (camelCase, nulls omitted).</summary>
    public static string ToJson(NetworkGraph graph) => GraphCodec.ToJson(graph);

    /// <summary>Base64 of gzip(UTF-8 JSON).</summary>
    public static string Gzip64(string json)
    {
        using var ms = new MemoryStream();
        using (var gz = new GZipStream(ms, CompressionLevel.Optimal, leaveOpen: true))
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            gz.Write(bytes, 0, bytes.Length);
        }
        return Convert.ToBase64String(ms.ToArray());
    }

    /// <summary>Inverse of <see cref="Gzip64"/> (tests and diagnostics).</summary>
    public static string Gunzip64(string data)
    {
        using var gz = new GZipStream(new MemoryStream(Convert.FromBase64String(data)), CompressionMode.Decompress);
        using var reader = new StreamReader(gz, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    /// <summary>The response body for a graph request: the graph JSON node, or <c>{ encoding, data }</c> for gzip64.</summary>
    public static JsonNode Body(NetworkGraph graph, string rawMode, string encoding)
    {
        var json = ToJson(FilterRaw(graph, rawMode));
        return encoding == EncodingGzip64
            ? new JsonObject { ["encoding"] = GzipBase64, ["data"] = Gzip64(json) }
            : JsonNode.Parse(json)!;
    }

    /// <summary><c>{ nodeId, raw }</c> for one node, or null when the graph has no such node.</summary>
    public static JsonObject? NodeRaw(NetworkGraph graph, string nodeId)
    {
        var n = graph.Nodes.FirstOrDefault(x => x.Id == nodeId);
        return n is null ? null : new JsonObject { ["nodeId"] = n.Id, ["raw"] = n.Raw?.DeepClone() };
    }
}
