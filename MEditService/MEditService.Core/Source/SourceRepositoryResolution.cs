using System.Text.Json;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Core.Source;

/// <summary>The file holding a record: found on disk for a container or embedded child, computed for
/// a flat record. A null <see cref="SourceUnit.OwnerRecordType"/> means the document names its own
/// type (ADR-0041's path-ambiguous groups).</summary>
internal readonly record struct SourceUnit(
    string FullPath, string RelativePath, string OwnerFormKey, string? OwnerRecordType, bool IsEmbedded)
{
    /// <summary>A container's own field file, not a flat file. The header's root RecordData.json shares
    /// the filename, so <see cref="OwnerRecordType"/> distinguishes them, or a header delete would
    /// remove the whole source root.</summary>
    internal bool IsDirectoryPerRecord =>
        OwnerRecordType != PluginHeader.RecordType
        && Path.GetFileName(FullPath).Equals(SourceUnitResolver.RecordDataFileName, StringComparison.Ordinal);
}

/// <summary>Resolution: which document in the tree holds a record. The listing memo and the
/// embedded-owner map are the repository's own per-operation state, and nothing outside it holds
/// either.</summary>
public sealed partial class SourceRepository
{
    // One repository is one operation, so both live and die with it: the next Track, compile or edit
    // looks at the tree again (ADR-0001 — never a file timestamp).
    private readonly Dictionary<string, string[]> _entriesByScanRoot = new(StringComparer.Ordinal);
    private readonly Dictionary<string, EmbeddedOwners> _ownersBySourceRoot = new(StringComparer.Ordinal);

    /// <summary>The document holding <paramref name="identity"/>, and whether that document is another
    /// record's. The one place an identity becomes a path; the callers still holding one are moving off
    /// it.</summary>
    internal SourceUnit? Locate(PluginKey plugin, RecordIdentity identity)
    {
        // The header's unit is the fixed root RecordData.json: nothing to compute, scan or embed.
        if (identity.RecordType == PluginHeader.RecordType)
        {
            var headerPath = Path.Combine(
                _modFolder, SourceRecordPath.RootFor(plugin.Name), SourceUnitResolver.RecordDataFileName);
            return Unit(headerPath, identity.FormKey, identity.RecordType, isEmbedded: false);
        }

        // A flat record: the path is computed, then corrected if the file has been renamed out from
        // under it. The overwhelmingly common edit pays one File.Exists and searches nothing.
        try
        {
            var flat = SourceUnitResolver.FlatSourcePath(
                _modFolder, plugin.Name, identity.RecordType, identity.FormKey, identity.EditorId, _release);
            return Unit(flat, identity.FormKey, identity.RecordType, isEmbedded: false);
        }
        catch (NotSupportedException)
        {
            // Not flat — a container, or a child with no top-level group of its own. Fall through.
        }

        // Only a directory-per-record type (Cell, Worldspace) can have a directory of its own; a type
        // with no group of its own is always embedded, so nothing is scanned for it.
        var sourceRoot = Path.Combine(_modFolder, SourceRecordPath.RootFor(plugin.Name));
        if (RecordTypeDispatch.For(_release).GroupFolderNameFor(identity.RecordType) is not null
            && FindOwnUnit(sourceRoot, identity.FormKey) is { } own)
        {
            return Unit(own, identity.FormKey, identity.RecordType, isEmbedded: false);
        }

        // Nothing of its own, so it is inlined in another record's document, which the owner map names.
        if (OwnersUnder(sourceRoot).DocumentHolding(identity.FormKey) is not { } owner) return null;

        return Unit(owner.FullPath, owner.FormKey, owner.RecordType, isEmbedded: true);
    }

    /// <summary>True when another record's document in this plugin's tree carries
    /// <paramref name="formKey"/>: the embedded child a caller holding no record type cannot ask
    /// <see cref="Locate"/> about (#779).</summary>
    internal bool CarriesEmbedded(PluginKey plugin, string formKey) =>
        OwnersUnder(Path.Combine(_modFolder, SourceRecordPath.RootFor(plugin.Name)))
            .DocumentHolding(formKey) is not null;

    private SourceUnit Unit(string fullPath, string ownerFormKey, string? ownerRecordType, bool isEmbedded) =>
        new(fullPath, Path.GetRelativePath(_modFolder, fullPath), ownerFormKey, ownerRecordType, isEmbedded);

    // Matches the FormKey alone, never the EditorID, which a caller may hold stale mid-rename. Every
    // directory-per-record group is searched, since a cell's directory sits in its own group's blocks
    // or inside its worldspace's.
    private string? FindOwnUnit(string sourceRoot, string formKey)
    {
        var suffix = SourceUnitResolver.FilesafeFormKey(formKey);
        var matches = new List<string>();
        foreach (var groupFolder in RecordTypeDispatch.For(_release).DirectoryPerRecordFolderNames)
        {
            var scanRoot = Path.Combine(sourceRoot, groupFolder);
            if (!Directory.Exists(scanRoot)) continue;

            // The subtree is listed once per repository and the pre-filter runs in memory, leaving
            // the name test below as the only real one.
            var candidates = EntriesUnder(scanRoot)
                .Where(e => Path.GetFileName(e).Contains(suffix, StringComparison.OrdinalIgnoreCase));
            matches.AddRange(candidates.Select(entry => AsSourceUnitFile(entry, suffix)).OfType<string>().Take(2));
            if (matches.Count > 1) break;
        }

        return matches.Count switch
        {
            0 => null,
            1 => matches[0],
            _ => throw new AmbiguousSourceUnitException(
                $"More than one source unit under '{sourceRoot}' claims FormKey {formKey}. A FormKey is " +
                "unique within a mod, so this tree is corrupt — resolve the duplicate by hand before editing."),
        };
    }

    // A directory whose name carries the FormKey holds RecordData.json; a file whose name carries it is
    // the record.
    private static string? AsSourceUnitFile(string entry, string filesafeFormKey)
    {
        var leaf = Path.GetFileName(entry);

        if (Directory.Exists(entry))
        {
            if (!SourceUnitResolver.NameCarries(leaf, filesafeFormKey)) return null;
            var recordData = Path.Combine(entry, SourceUnitResolver.RecordDataFileName);
            return File.Exists(recordData) ? recordData : null;
        }

        return SourceUnitResolver.NameCarries(leaf, filesafeFormKey + SourceUnitResolver.JsonSuffix) ? entry : null;
    }

    // One listing per scan root turns a whole-mod pass from O(records × tree) into O(tree).
    private string[] EntriesUnder(string scanRoot)
    {
        if (_entriesByScanRoot.TryGetValue(scanRoot, out var cached)) return cached;
        var entries = Directory.EnumerateFileSystemEntries(scanRoot, "*", SearchOption.AllDirectories).ToArray();
        _entriesByScanRoot[scanRoot] = entries;
        return entries;
    }

    // Every verb that writes calls this: the memo and the owner maps describe a tree this repository
    // has just changed, and reading them afterwards would answer about the tree as it stood.
    private void Forget()
    {
        _entriesByScanRoot.Clear();
        _ownersBySourceRoot.Clear();
    }

    private EmbeddedOwners OwnersUnder(string sourceRoot)
    {
        if (_ownersBySourceRoot.TryGetValue(sourceRoot, out var owners)) return owners;
        owners = new EmbeddedOwners(sourceRoot, _release);
        _ownersBySourceRoot[sourceRoot] = owners;
        return owners;
    }

    // Which document carries a record no path names — a placed reference in its cell, a response in
    // its quest. One map per plugin's source root, from one token scan of every document under it.
    private sealed class EmbeddedOwners
    {
        // The document a child sits inside: its file, the record at its root, and that record's type
        // where the path decides it — null means the document names its own.
        internal readonly record struct OwnerDocument(string FullPath, string FormKey, string? RecordType);

        private readonly string _sourceRoot;
        private readonly GameRelease _release;
        private Dictionary<string, OwnerDocument> _byChild;
        private bool _rescanned;

        internal EmbeddedOwners(string sourceRoot, GameRelease release)
        {
            (_sourceRoot, _release) = (sourceRoot, release);
            _byChild = Scan(sourceRoot, release);
        }

        // Every answer is checked against the document's current text, so an entry the tree does not
        // bear out is absence, never a stale owner. Read again at most once per repository (ADR-0001).
        internal OwnerDocument? DocumentHolding(string formKey)
        {
            if (_byChild.TryGetValue(formKey, out var owner) && StillCarries(owner.FullPath, formKey)) return owner;

            if (!_rescanned)
            {
                _rescanned = true;
                _byChild = Scan(_sourceRoot, _release);
            }

            return _byChild.TryGetValue(formKey, out var fresh) && StillCarries(fresh.FullPath, formKey)
                ? fresh
                : null;
        }

        private static bool StillCarries(string documentPath, string formKey) =>
            DocumentBytes(documentPath) is { } bytes
            && FormKeysIn(bytes).Any(k => k.FormKey.Equals(formKey, StringComparison.Ordinal));

        // First document wins a FormKey two of them claim: that tree is corrupt, and refusing to answer
        // at all would take every unrelated record down with it.
        private static Dictionary<string, OwnerDocument> Scan(string sourceRoot, GameRelease release)
        {
            var byChild = new Dictionary<string, OwnerDocument>(StringComparer.Ordinal);
            if (!Directory.Exists(sourceRoot)) return byChild;

            var modFolder = Path.GetDirectoryName(Path.GetDirectoryName(sourceRoot))!;
            foreach (var documentPath in Directory.EnumerateFiles(sourceRoot, "*.json", SearchOption.AllDirectories))
            {
                if (SourceDocuments.CarriesNoRecord(documentPath)) continue;
                if (DocumentBytes(documentPath) is not { } bytes) continue;

                var keys = FormKeysIn(bytes);
                if (keys.FirstOrDefault(k => k.AtRoot).FormKey is not { } root) continue;

                // A null type is an answer, not a skip: a path-ambiguous group's documents name their
                // own type, and dropping them leaves every child they carry unlocatable.
                var recordType = SourceRecordPath.RecordTypeOf(Path.GetRelativePath(modFolder, documentPath), release);

                var owner = new OwnerDocument(documentPath, root, recordType);
                foreach (var (childFormKey, atRoot) in keys)
                {
                    if (!atRoot) byChild.TryAdd(childFormKey, owner);
                }
            }
            return byChild;
        }

        // Never exclusive owners of the file: it may be gone or locked since the listing.
        private static byte[]? DocumentBytes(string path)
        {
            try
            {
                return File.Exists(path) ? SourceUnitResolver.StripUtf8Bom(File.ReadAllBytes(path)) : null;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return null;
            }
        }

        // Every FormKey the document declares, each flagged with whether it is the root record's own.
        // Malformed text yields what was read before the break.
        private static List<(string FormKey, bool AtRoot)> FormKeysIn(byte[] bytes)
        {
            var found = new List<(string, bool)>();
            var reader = new Utf8JsonReader(bytes);
            var atFormKey = false;
            var depth = 0;
            try
            {
                while (reader.Read())
                {
                    if (reader.TokenType == JsonTokenType.PropertyName)
                    {
                        atFormKey = reader.ValueTextEquals(FormKeyPropertyName);
                        depth = reader.CurrentDepth;
                        continue;
                    }
                    if (atFormKey && reader.TokenType == JsonTokenType.String)
                        found.Add((reader.GetString()!, depth == 1));
                    atFormKey = false;
                }
            }
            catch (JsonException)
            {
                // Caught mid-save, or hand-edited into something that is not a document.
            }
            return found;
        }

        private static ReadOnlySpan<byte> FormKeyPropertyName => "FormKey"u8;
    }
}
