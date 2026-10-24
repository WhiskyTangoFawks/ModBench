using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.TestSupport;

/// <summary>Every document a plugin's tree holds, asked of the repository: the header's and each
/// record's own, an embedded child belonging to the document that carries it.</summary>
public static class TreeDocuments
{
    public static IReadOnlyList<SourceDocument> Of(ISourceRepository repository, PluginAddress plugin) =>
        repository.ReadDocuments(plugin, RootsOf).Value();

    private static IReadOnlyList<SourceDocument> RootsOf(IPluginDocuments documents)
    {
        var roots = HeaderOfATreeHoldingOne(documents);
        var embedded = new HashSet<string>(StringComparer.Ordinal);
        foreach (var document in documents.Records)
        {
            if (roots.Count > 0 && embedded.Contains(document.FormKey) && document.FormKey != roots[^1].FormKey) continue;
            roots.Add(document);
            embedded = FormKeysOfTheChildrenItEmbeds(document.Text);
        }

        return
        [
            .. roots.Select(
                document => new SourceDocument(document.FormKey, document.RecordType, DocumentTokens.EditorIdIn(document.Text).EditorId, document.Text)),
        ];
    }

    private static List<PluginDocument> HeaderOfATreeHoldingOne(IPluginDocuments documents)
    {
        try
        {
            return [documents.Header];
        }
        catch (FileNotFoundException)
        {
            return [];
        }
    }

    private static HashSet<string> FormKeysOfTheChildrenItEmbeds(string text)
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
