using System.Text.Json;
using MEditService.Codec.Schema;

namespace MEditService.Index;

public static class CallerText
{
    public static (string Body, string? EditorId, string? ParseDiagnosis) Read(string text)
    {
        try
        {
            using var parsed = JsonDocument.Parse(text);
            return parsed.RootElement.ValueKind == JsonValueKind.Object
                ? (text, DocumentNodes.At(parsed.RootElement, "EditorID")?.GetString(), null)
                : ("{}", null, "A record's document is a JSON object.");
        }
        catch (JsonException ex)
        {
            return ("{}", null, ex.Message);
        }
    }
}
