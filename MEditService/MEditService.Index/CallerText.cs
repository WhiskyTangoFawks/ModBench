using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;

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
            var root = parsed.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return (NoBody, null, "A record's document is a JSON object.");
            return DocumentNodes.HoldsEditorIdThatIsNoString(root)
                ? (NoBody, null, $"A record's '{RecordMembers.EditorId}' is a string.")
                : (text, DocumentNodes.EditorIdOf(root), null);
        }
        catch (JsonException ex)
        {
            return (NoBody, null, ex.Message);
        }
    }
}
