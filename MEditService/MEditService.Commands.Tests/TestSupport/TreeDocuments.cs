using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Every document a plugin's tree holds, asked of the repository: the header's and each
/// record's own, an embedded child belonging to the document that carries it.</summary>
internal static class TreeDocuments
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    internal static IReadOnlyList<SourceDocument> Of(SourceRepository repository, PluginAddress plugin)
    {
        using var documents = repository.OpenDocuments(plugin, Schemas);
        var roots = new List<PluginDocument>();
        try
        {
            roots.Add(documents.Header);
        }
        catch (FileNotFoundException)
        {
            // A plugin whose tree holds no root document holds no header.
        }

        foreach (var document in documents.Records)
        {
            if (roots.Count > 0 && IsEmbeddedIn(roots[^1], document)) continue;
            roots.Add(document);
        }

        return
        [
            .. roots.Select(
                document => new SourceDocument(document.FormKey, document.RecordType, EditorIdOf(document.Text), document.Text)),
        ];
    }

    // An embedded child follows the document that carries it, and that document holds an object of the
    // child's own FormKey below its root.
    private static bool IsEmbeddedIn(PluginDocument owner, PluginDocument child)
    {
        using var json = JsonDocument.Parse(owner.Text);
        return child.FormKey != owner.FormKey && HoldsBelowTheRoot(json.RootElement, child.FormKey, atRoot: true);
    }

    private static bool HoldsBelowTheRoot(JsonElement element, string formKey, bool atRoot)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var member in element.EnumerateObject())
                {
                    if (!atRoot && member.Name == "FormKey" && member.Value.ValueKind == JsonValueKind.String
                        && member.Value.GetString() == formKey)
                    {
                        return true;
                    }
                    if (HoldsBelowTheRoot(member.Value, formKey, atRoot: false)) return true;
                }
                return false;
            case JsonValueKind.Array:
                return element.EnumerateArray().Any(item => HoldsBelowTheRoot(item, formKey, atRoot: false));
            default:
                return false;
        }
    }

    private static string? EditorIdOf(string text)
    {
        using var json = JsonDocument.Parse(text);
        return json.RootElement.TryGetProperty("EditorID", out var editorId) && editorId.ValueKind == JsonValueKind.String
            ? editorId.GetString()
            : null;
    }
}
