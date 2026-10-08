using System.Text.Json;
using MEditService.Codec.Schema;

namespace MEditService.Commands.Edits;

internal static class EditorIds
{
    /// <summary>The EditorID a written document's own text names, which the put names the unit by.</summary>
    internal static string? In(string text)
    {
        using var document = JsonDocument.Parse(text);
        return DocumentNodes.EditorIdOf(document.RootElement).EditorId;
    }
}
