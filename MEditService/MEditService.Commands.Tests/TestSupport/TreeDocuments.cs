using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Every document a plugin's tree holds, asked of the repository: the header's and each
/// record's own, an embedded child belonging to the document that carries it.</summary>
internal static class TreeDocuments
{

    internal static IReadOnlyList<SourceDocument> Of(SourceRepository repository, PluginAddress plugin) =>
        repository.ReadDocuments(plugin, RootsOf).Value();

    private static IReadOnlyList<SourceDocument> RootsOf(IPluginDocuments documents)
    {
        var roots = new List<PluginDocument>();
        try
        {
            roots.Add(documents.Header);
        }
        catch (FileNotFoundException)
        {
            // A plugin whose tree holds no root document holds no header.
        }

        var embedded = new HashSet<string>(StringComparer.Ordinal);
        foreach (var document in documents.Records)
        {
            if (roots.Count > 0 && embedded.Contains(document.FormKey) && document.FormKey != roots[^1].FormKey) continue;
            roots.Add(document);
            embedded = FormKeysBelowTheRoot(document.Text);
        }

        return
        [
            .. roots.Select(
                document => new SourceDocument(document.FormKey, document.RecordType, DocumentTokens.EditorIdIn(document.Text).EditorId, document.Text)),
        ];
    }

    // An embedded child follows the document that carries it, and that document holds an object of the
    // child's own FormKey below its root.
    private static HashSet<string> FormKeysBelowTheRoot(string text)
    {
        using var json = JsonDocument.Parse(text);
        var found = new HashSet<string>(StringComparer.Ordinal);
        Collect(json.RootElement, found, atRoot: true);
        return found;
    }

    private static void Collect(JsonElement element, HashSet<string> found, bool atRoot)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var member in element.EnumerateObject())
                {
                    if (!atRoot && member.Name == "FormKey" && member.Value.ValueKind == JsonValueKind.String) found.Add(member.Value.GetString() ?? string.Empty);
                    Collect(member.Value, found, atRoot: false);
                }
                break;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray()) Collect(item, found, atRoot: false);
                break;
        }
    }
}
