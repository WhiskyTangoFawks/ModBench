using System.Text;
using System.Text.Json;
using MEditService.Core.Records;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>Whole-plugin reads: every document at the working tree, and the same question answered at
/// a named ref through git plumbing, with no checkout and no second working tree.</summary>
public sealed partial class SourceRepository
{
    /// <summary>Every document one plugin's tree holds right now, each as the record at its root. An
    /// embedded child belongs to its owner's document; <see cref="Get"/> answers with the child's own
    /// text.</summary>
    public IReadOnlyList<SourceDocument> ReadAll(PluginKey plugin)
    {
        var root = SourceDocuments.RootIn(_modFolder, plugin.Name);
        if (!Directory.Exists(root)) return [];

        var documents = new List<SourceDocument>();
        foreach (var path in Directory.EnumerateFiles(root, $"*{SourceUnitResolver.JsonSuffix}", SearchOption.AllDirectories))
        {
            if (ReadOrNull(path) is not { } text) continue;
            if (DocumentAt(Path.GetRelativePath(_modFolder, path), text, plugin.Name) is { } document)
                documents.Add(document);
        }
        return documents;
    }

    /// <summary>The same set as <paramref name="gitRef"/> committed it, straight from the object store:
    /// a working-tree edit is invisible here, and the ref needs no checkout. Empty when nothing is at
    /// that ref.</summary>
    public IReadOnlyList<SourceDocument> ReadAll(PluginKey plugin, string gitRef) =>
        [.. BlobsAtRef(plugin.Name, gitRef)
            .Select(blob => DocumentAt(blob.RelativePath, blob.Text, plugin.Name))
            .OfType<SourceDocument>()];

    /// <summary>One record's own text as <paramref name="gitRef"/> has it, re-extracted through the
    /// codec when another record's committed document carries it. Null when nothing at that ref holds
    /// it.</summary>
    public SourceDocument? GetAt(PluginKey plugin, RecordIdentity identity, string gitRef)
    {
        SourceDocument Own(string body) =>
            new(identity.FormKey, identity.RecordType, identity.EditorId, body);

        foreach (var (relativePath, text) in BlobsAtRef(plugin.Name, gitRef))
        {
            if (DocumentAt(relativePath, text, plugin.Name) is not { } document) continue;
            if (document.FormKey.Equals(identity.FormKey, StringComparison.Ordinal)) return Own(document.Body);

            // The owner's whole document, so the child is cut back out of it exactly as a working-tree
            // read does.
            if (!CarriesFormKey(text, identity.FormKey)) continue;
            var unit = new SourceUnit(
                relativePath, relativePath, document.FormKey, document.RecordType, IsEmbedded: true);
            if (SourceUnitResolver.RecordBodyFromOwnerBytes(
                    Encoding.UTF8.GetBytes(text), unit, identity.FormKey, _release, Codec) is { } body)
            {
                return Own(body);
            }
        }
        return null;
    }

    /// <summary>Writes the plugin's tree as <paramref name="gitRef"/> has it under
    /// <paramref name="destinationRoot"/>, same layout, no <c>.git</c> — the scratch checkout a
    /// whole-mod read at a ref needs.</summary>
    internal void MaterializeAtRef(PluginKey plugin, string gitRef, string destinationRoot)
    {
        foreach (var (relativePath, text) in BlobsAtRef(plugin.Name, gitRef))
        {
            var destination = Path.Combine(destinationRoot, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.WriteAllText(destination, text);
        }
    }

    /// <summary>Which FormKeys more than one document claims. Asked of the tree, not the compiled mod:
    /// the reader's FormKey-keyed RecordCache silently collapses two files in one group folder to the
    /// last read.</summary>
    internal IReadOnlyList<string> FormKeysWithMoreThanOneDocument(PluginKey plugin, IEnumerable<FormKey> formKeys) =>
        SourceUnitResolver.FormKeysWithMoreThanOneSourceUnit(
            SourceDocuments.RootIn(_modFolder, plugin.Name), formKeys);

    // The plugin's committed subtree, path and text, from one ls-tree plus one cat-file per blob.
    // Empty, never null: "nothing at that ref" is an answer here.
    private IEnumerable<(string RelativePath, string Text)> BlobsAtRef(string pluginName, string gitRef)
    {
        if (!IsTracked(_modFolder)) yield break;

        var gitDir = Path.Combine(_modFolder, ".git");
        var sourcePrefix = ToGitPath(SourceRecordPath.RootFor(pluginName));
        if (!GitCli.TryRun(gitDir, _modFolder, out var listing, "ls-tree", "-r", "-z", gitRef, "--", $"{sourcePrefix}/"))
            yield break;

        // -z so a path carrying a space or non-ASCII survives verbatim; every source path segment
        // comes from a plugin filename or an EditorID.
        foreach (var entry in listing.Split('\0', StringSplitOptions.RemoveEmptyEntries))
        {
            // "<mode> SP <type> SP <object> TAB <file>"
            var tab = entry.IndexOf('\t', StringComparison.Ordinal);
            if (tab < 0) continue;
            var fields = entry[..tab].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (fields.Length < 3 || fields[1] != "blob") continue;
            var gitPath = entry[(tab + 1)..];

            // cat-file -p, not show: for a missing glob-shaped path show exits 0 with empty output.
            if (!GitCli.TryRun(gitDir, _modFolder, out var text, "cat-file", "-p", $"{gitRef}:{gitPath}")) continue;
            yield return (gitPath.Replace('/', Path.DirectorySeparatorChar), text);
        }
    }

    // Null for a file that holds no record: group and block metadata, a document that declares no
    // FormKey, and one whose type neither its path nor its own text names.
    private SourceDocument? DocumentAt(string relativePath, string text, string pluginFileName)
    {
        if (SourceDocuments.CarriesNoRecord(relativePath)) return null;

        var headerDocument = Path.Combine(
            SourceRecordPath.RootFor(pluginFileName), SourceUnitResolver.RecordDataFileName);
        if (SourceDocuments.FormKeyDeclaredIn(text, relativePath, headerDocument, pluginFileName) is not { } formKey)
            return null;

        var recordType = SourceRecordPath.RecordTypeOf(relativePath, _release)
                         ?? SourceDocuments.RootStringIn(text, "MutagenObjectType");
        return recordType == null
            ? null
            : new SourceDocument(formKey, recordType, SourceDocuments.RootStringIn(text, "EditorID"), text);
    }

    private static bool CarriesFormKey(string text, string formKey)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            return CarriesFormKey(document.RootElement, formKey);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool CarriesFormKey(JsonElement element, string formKey) => element.ValueKind switch
    {
        JsonValueKind.Object => element.EnumerateObject().Any(p =>
            (p.NameEquals("FormKey") && p.Value.ValueKind == JsonValueKind.String && p.Value.ValueEquals(formKey))
            || CarriesFormKey(p.Value, formKey)),
        JsonValueKind.Array => element.EnumerateArray().Any(item => CarriesFormKey(item, formKey)),
        _ => false,
    };

    // Never exclusive owners of the file: it may have been deleted, moved or locked since the listing.
    private static string? ReadOrNull(string path)
    {
        try
        {
            return Encoding.UTF8.GetString(SourceUnitResolver.StripUtf8Bom(File.ReadAllBytes(path)));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
