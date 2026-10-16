using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Amazon.Runtime;
using Duplo.Extension.NetMap.Core.Graph;

namespace Duplo.Extension.NetMap.Core.Aws;

/// <summary>AWS SDK model → sanitized JsonObject for GraphNode.Raw. ConstantClass values (VpcState, …) become plain
/// strings instead of {"Value": …}; nulls are dropped.</summary>
public static class RawJson
{
    private static readonly JsonSerializerOptions Options = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new ConstantClassConverterFactory() },
    };

    public static JsonObject From(object awsModel)
    {
        var node = JsonSerializer.SerializeToNode(awsModel, awsModel.GetType(), Options) as JsonObject ?? new JsonObject();
        return Sanitizer.Sanitize(node);
    }

    private sealed class ConstantClassConverterFactory : JsonConverterFactory
    {
        public override bool CanConvert(Type typeToConvert) => typeof(ConstantClass).IsAssignableFrom(typeToConvert);

        public override JsonConverter CreateConverter(Type typeToConvert, JsonSerializerOptions options) =>
            (JsonConverter)Activator.CreateInstance(typeof(ConstantClassConverter<>).MakeGenericType(typeToConvert))!;
    }

    private sealed class ConstantClassConverter<T> : JsonConverter<T> where T : ConstantClass
    {
        public override T Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
            throw new NotSupportedException("Raw AWS documents are write-only.");

        public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options) =>
            writer.WriteStringValue(value.Value);
    }
}
