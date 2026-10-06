using System.Text.Json;
using MEditService.Codec.Schema;

namespace MEditService.Index;

public static class CallerText
{
    /// <summary>The body a copy is read from when the caller's text yields none.</summary>
    public const string NoBody = "{}";

    public static (string Body, string? EditorId, string? ParseDiagnosis) Read(string text)
    {
        try
        {
            using var parsed = JsonDocument.Parse(text);
            return parsed.RootElement.ValueKind == JsonValueKind.Object
                ? (text, DocumentNodes.At(parsed.RootElement, "EditorID")?.GetString(), null)
                : (NoBody, null, "A record's document is a JSON object.");
        }
        catch (JsonException ex)
        {
            return (NoBody, null, ex.Message);
        }
    }
}
