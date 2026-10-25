using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MEditService.TestSupport;

public static class JsonStrings
{
    private static readonly JsonSerializerOptions Unescaped = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static string Of(JsonElement element) =>
        element.GetString() ?? throw new InvalidOperationException("Expected a JSON string value.");

    /// <summary>The node's JSON, escaping only what JSON requires escaped.</summary>
    public static string AsWritten(JsonNode node) => node.ToJsonString(Unescaped);
}
