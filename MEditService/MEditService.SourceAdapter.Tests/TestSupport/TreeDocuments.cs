using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.TestSupport;

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

    // An embedded child follows the document that carries it, and that document spells the child's own
    // FormKey member.
    private static bool IsEmbeddedIn(PluginDocument owner, PluginDocument child) =>
        child.FormKey != owner.FormKey
        && owner.Text.Contains($"\"FormKey\": \"{child.FormKey}\"", StringComparison.Ordinal);

    private static string? EditorIdOf(string text)
    {
        using var json = JsonDocument.Parse(text);
        return json.RootElement.TryGetProperty("EditorID", out var editorId) && editorId.ValueKind == JsonValueKind.String
            ? editorId.GetString()
            : null;
    }
}
