using System.Text.Json;
using MEditService.Codec.Schema;

namespace MEditService.Index;

public static class CallerText
{
    /// <summary>The body a copy is read from when the caller's text yields none.</summary>
    public const string NoBody = "{}";

    internal static (string Body, string? EditorId, string? ParseDiagnosis) Read(string text)
    {
        try
        {
            using var parsed = JsonDocument.Parse(text);
            var root = parsed.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return (NoBody, null, "A record's document is a JSON object.");
            var editorId = DocumentNodes.EditorIdOf(root);
            return editorId.WhyUnreadable is { } why ? (NoBody, null, $"The record's {why}.") : (text, editorId.EditorId, null);
        }
        catch (JsonException ex)
        {
            return (NoBody, null, ex.Message);
        }
    }
}
