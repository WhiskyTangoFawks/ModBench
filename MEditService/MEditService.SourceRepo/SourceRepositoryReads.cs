using System.Text;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceRepo;

/// <summary>Whole-plugin reads: every document at the working tree, and the same question answered at
/// a named ref through git plumbing, with no checkout and no second working tree.</summary>
public sealed partial class SourceRepository
{
    /// <summary>Every document one plugin's tree holds right now, each as the record at its root. An
    /// embedded child belongs to its owner's document; <see cref="Get"/> answers with the child's own
    /// text.</summary>
    public IReadOnlyList<SourceDocument> ReadAll(PluginKey plugin)
    {
        var root = RootIn(_modFolder, plugin.Name);
        if (!Directory.Exists(root)) return [];

        var documents = new List<SourceDocument>();
        foreach (var path in Directory.EnumerateFiles(root, $"*{JsonSuffix}", SearchOption.AllDirectories))
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
            if (RecordBodyFromOwnerBytes(Encoding.UTF8.GetBytes(text), unit, identity.FormKey, _release) is { } body)
            {
                return Own(body);
            }
        }
        return null;
    }

    /// <summary>The text HEAD commits for the record, or null when it is the text
    /// <paramref name="knownText"/> holds, no unit holds the record, or HEAD carries it nowhere. One
    /// record, so a clean one starts no git process.</summary>
    public string? CommittedTextIfMoved(PluginKey plugin, RecordIdentity identity, string knownText)
    {
        if (Locate(plugin, identity) is not { } unit) return null;

        // The hash fast path is meaningless for an embedded child: the blob at the unit's path is the
        // owner's whole document.
        if (!unit.IsEmbedded)
        {
            var hashes = CommittedSourceHashes(_modFolder, [unit.RelativePath]);
            if (hashes == null || !hashes.TryGetValue(ToGitPath(unit.RelativePath), out var headHash)) return null;

            // Equality is conclusive; inequality only sends us on to compare bytes, never an assertion of
            // change.
            if (headHash == GitBlobHash.Of(Encoding.UTF8.GetBytes(knownText))) return null;
        }

        if (ReadCommittedSourceText(_modFolder, unit.RelativePath) is not { } headOwnerText) return null;

        // Same BOM defence as RecordBodyFromOwnerBytes.
        headOwnerText = headOwnerText.TrimStart('﻿');

        // For an embedded child HEAD's text is the owner's document; null means the owner's HEAD copy
        // does not carry this child, which leaves the committed baseline alone (fail closed).
        var headText = unit.IsEmbedded
            ? RecordBodyFromOwnerBytes(Encoding.UTF8.GetBytes(headOwnerText), unit, identity.FormKey, _release)
            : headOwnerText;

        return headText is { } resolved && !string.Equals(resolved, knownText, StringComparison.Ordinal)
            ? resolved
            : null;
    }

    /// <summary>Every FormKey the plugin originates and its tree holds now, a record with a document
    /// of its own and an embedded child alike. The header is excluded: its key is synthetic.</summary>
    public IReadOnlySet<string> NativeFormKeysHeld(PluginKey plugin) => Native(ReadAll(plugin), plugin);

    /// <summary>The same set as <paramref name="gitRef"/> committed it, so an ID a working-tree
    /// deletion freed stays taken until the plugin is compiled.</summary>
    public IReadOnlySet<string> NativeFormKeysHeldAt(PluginKey plugin, string gitRef) =>
        Native(ReadAll(plugin, gitRef), plugin);

    private static HashSet<string> Native(IReadOnlyList<SourceDocument> documents, PluginKey plugin)
    {
        var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var document in documents)
        {
            if (document.RecordType != PluginHeader.RecordType) AddIfNative(keys, document.FormKey, plugin);

            // A child inlined in this document is a record of its own with a FormKey of its own, so its
            // ID is as taken as any other.
            foreach (var (formKey, _, inAnEmbedSlot) in FormKeysIn(Encoding.UTF8.GetBytes(document.Body)))
            {
                if (inAnEmbedSlot) AddIfNative(keys, formKey, plugin);
            }
        }
        return keys;
    }

    // Native: the record's own FormKey names this plugin, so this plugin allocated it — an override of
    // a master carries the master's key and takes none of this plugin's space.
    private static void AddIfNative(HashSet<string> keys, string formKey, PluginKey plugin)
    {
        var colon = formKey.IndexOf(':', StringComparison.Ordinal);
        if (colon > 0 && formKey.AsSpan(colon + 1).Equals(plugin.Name, StringComparison.OrdinalIgnoreCase))
            keys.Add(formKey);
    }

    // The plugin's committed subtree, path and text, from one ls-tree plus one cat-file per blob.
    // Empty, never null: "nothing at that ref" is an answer here.
    private IEnumerable<(string RelativePath, string Text)> BlobsAtRef(string pluginName, string gitRef)
    {
        if (!IsTracked(_modFolder)) yield break;

        var gitDir = Path.Combine(_modFolder, ".git");
        var sourcePrefix = ToGitPath(RootFor(pluginName));
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
        if (CarriesNoRecord(relativePath)) return null;

        if (FormKeyDeclaredIn(text, relativePath, HeaderDocumentFor(pluginFileName), pluginFileName)
            is not { } formKey)
            return null;

        var recordType = RecordTypeOf(relativePath, _release)
                         ?? RootStringIn(text, "MutagenObjectType");
        return recordType == null
            ? null
            : new SourceDocument(formKey, recordType, RootStringIn(text, "EditorID"), text);
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
            return Encoding.UTF8.GetString(StripUtf8Bom(File.ReadAllBytes(path)));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
