using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceRepo;

/// <summary>The file holding a record: found on disk for a container or embedded child, computed for
/// a flat record. A null <see cref="SourceUnit.OwnerRecordType"/> means the document names its own
/// type.</summary>
public readonly record struct SourceUnit(
    string FullPath, string RelativePath, string OwnerFormKey, string? OwnerRecordType, bool IsEmbedded)
{
    /// <summary>A container's own field file, not a flat file. The header's root RecordData.json shares
    /// the filename, so <see cref="OwnerRecordType"/> distinguishes them, or a header delete would
    /// remove the whole source root.</summary>
    internal bool IsDirectoryPerRecord =>
        OwnerRecordType != PluginHeader.RecordType
        && Path.GetFileName(FullPath).Equals(SourceRepository.RecordDataFileName, StringComparison.Ordinal);
}

/// <summary>The unit holding a record: the document it is, relative to the mod folder, whose record
/// that document is, and whether it is a directory of its own. One read, so the facts and the path
/// cannot disagree.</summary>
public sealed record HoldingUnit(
    string RelativePath, bool IsEmbedded, string OwnerFormKey, string? OwnerRecordType,
    bool IsDirectoryPerRecord);

/// <summary>Where the tree puts a cell: the worldspace whose subtree carries it and the block
/// directories it sits in. An interior cell has neither; a worldspace's own top cell has a
/// worldspace and no block.</summary>
public readonly record struct CellPlacement(
    string? ParentWorldspace, int? BlockX, int? BlockY, int? SubX, int? SubY, bool IsInterior);

/// <summary>Resolution: which document in the tree holds a record. The listing memo and the
/// embedded-owner map are the repository's own per-operation state, and nothing outside it holds
/// either.</summary>
public sealed partial class SourceRepository
{
    // One repository is one operation, so both live and die with it: the next Track, compile or edit
    // looks at the tree again (ADR-0009 — never a file timestamp).
    private readonly Dictionary<string, string[]> _entriesByScanRoot = new(StringComparer.Ordinal);
    private readonly Dictionary<string, EmbeddedOwners> _ownersBySourceRoot = new(StringComparer.Ordinal);

    /// <summary>The unit holding <paramref name="identity"/>, as the document it is and the facts about
    /// it. Null when no document in the tree holds it, which is a refusal to the caller.</summary>
    public HoldingUnit? UnitHolding(PluginCopyKey plugin, RecordIdentity identity) =>
        Locate(plugin, identity) is { } unit
            ? new HoldingUnit(
                unit.RelativePath, unit.IsEmbedded, unit.OwnerFormKey, unit.OwnerRecordType,
                unit.IsDirectoryPerRecord)
            : null;

    /// <summary>The document holding <paramref name="identity"/>, and whether that document is another
    /// record's. The one place an identity becomes a path, which is why it stays here.</summary>
    internal SourceUnit? Locate(PluginCopyKey plugin, RecordIdentity identity)
    {
        if (identity.RecordType == PluginHeader.RecordType)
        {
            return Unit(
                HeaderDocumentIn(_modFolder, plugin.Name), identity.FormKey, identity.RecordType, isEmbedded: false);
        }

        // A flat record: the path is computed, then corrected if the file has been renamed out from
        // under it. The overwhelmingly common edit pays one File.Exists and searches nothing.
        try
        {
            var flat = FlatSourcePath(
                _modFolder, plugin.Name, identity.RecordType, identity.FormKey, identity.EditorId, _release);
            return Unit(flat, identity.FormKey, identity.RecordType, isEmbedded: false);
        }
        catch (NotSupportedException)
        {
            // Not flat — a container, or a child with no top-level group of its own. Fall through.
        }

        // Only a directory-per-record type (Cell, Worldspace) can have a directory of its own; a type
        // with no group of its own is always embedded, so nothing is scanned for it.
        var sourceRoot = Path.Combine(_modFolder, RootFor(plugin.Name));
        if (RecordTypeDispatch.For(_release).GroupFolderNameFor(identity.RecordType) is not null
            && FindOwnUnit(sourceRoot, identity.FormKey) is { } own)
        {
            return Unit(own, identity.FormKey, identity.RecordType, isEmbedded: false);
        }

        // Nothing of its own, so it is inlined in another record's document, which the owner map names.
        if (OwnersUnder(sourceRoot).DocumentHolding(identity.FormKey) is not { } owner) return null;

        return Unit(owner.FullPath, owner.FormKey, owner.RecordType, isEmbedded: true);
    }

    /// <summary>Which record the tree holds at <paramref name="formKey"/> — one with a document of
    /// its own, an embedded child, or the header — or null when nothing carries it.</summary>
    public RecordIdentity? IdentityOf(
        PluginCopyKey plugin, string formKey, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        // A malformed FormKey is a caller's raw input, not a broken tree: it names nothing and throws
        // nothing.
        if (!FormKey.TryFactory(formKey, out var parsed)) return null;
        var spelled = parsed.ToString();

        var sourceRoot = Path.Combine(_modFolder, RootFor(plugin.Name));
        if (!Directory.Exists(sourceRoot)) return null;

        // The header's document is the fixed root RecordData.json, and it declares a ModKey rather
        // than the FormKey the index files it under, so no name or text in the tree carries that key.
        if (spelled.Equals(PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name)), StringComparison.OrdinalIgnoreCase))
        {
            return File.Exists(HeaderDocumentIn(_modFolder, plugin.Name))
                ? new RecordIdentity(spelled, PluginHeader.RecordType, null)
                : null;
        }

        if (OwnDocumentIdentity(sourceRoot, plugin.Name, parsed, spelled, schemas) is { } own) return own;

        // Nothing of its own, so another record's document carries it inline, and the codec reads its
        // type and name off that document's text.
        if (OwnersUnder(sourceRoot).DocumentHolding(spelled) is not { } owner) return null;
        if (BytesOrNull(owner.FullPath) is not { } ownerBytes) return null;
        if (new ContainerDocuments(_release, schemas).EmbeddedIdentity(owner.RecordType, ownerBytes, spelled)
            is not { } child)
        {
            return null;
        }

        return new RecordIdentity(spelled, child.RecordType, child.EditorId);
    }

    /// <summary>The reader's own words for a document whose name carries <paramref name="formKey"/>
    /// and whose text is not one; null when the tree names no such document.</summary>
    public string? UnreadableDocumentFor(PluginCopyKey plugin, string formKey)
    {
        if (!FormKey.TryFactory(formKey, out var parsed)) return null;
        var sourceRoot = Path.Combine(_modFolder, RootFor(plugin.Name));
        if (!Directory.Exists(sourceRoot)) return null;

        foreach (var documentPath in DocumentsNaming(sourceRoot, parsed.ToString()))
        {
            if (ReadOrNull(documentPath) is { } text && NotADocument(text) is { } why) return why;
        }
        return null;
    }

    // Its root has to be a JSON object before any member of it can be read; anything else is a file
    // something else wrote over the document, and the reader's message is the whole diagnosis.
    private static string? NotADocument(string text)
    {
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(text);
            return document.RootElement.ValueKind == JsonValueKind.Object ? null : "its root is not a JSON object.";
        }
        catch (JsonException ex)
        {
            return ex.Message;
        }
    }

    // Every entry whose leaf name carries the FormKey, as the path of the document it stands for: a
    // directory holds its record in RecordData.json, a file is the record.
    private IEnumerable<string> DocumentsNaming(string sourceRoot, string spelled)
    {
        // Computed once rather than per entry: NameCarriesFormKey reparses the FormKey on every call.
        var filesafe = FilesafeFormKey(spelled);
        foreach (var entry in EntriesUnder(sourceRoot))
        {
            var leaf = Path.GetFileName(entry);
            if (!NameCarries(leaf, filesafe) && !NameCarries(leaf, filesafe + JsonSuffix)) continue;

            yield return Directory.Exists(entry) ? Path.Combine(entry, RecordDataFileName) : entry;
        }
    }

    // A record with a document of its own: its leaf name carries the FormKey and the text bears that
    // out. A name the text contradicts is stale, and the record it claims is elsewhere or gone.
    private RecordIdentity? OwnDocumentIdentity(
        string sourceRoot, string pluginFileName, FormKey formKey, string spelled,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        foreach (var documentPath in DocumentsNaming(sourceRoot, spelled))
        {
            if (ReadOrNull(documentPath) is not { } text) continue;
            var relativePath = Path.GetRelativePath(_modFolder, documentPath);
            if (DocumentAt(relativePath, text, pluginFileName) is not { } document) continue;
            if (!FormKey.TryFactory(document.FormKey, out var declared) || declared != formKey) continue;

            // A path-ambiguous group's document names its own type, and that name is the codec's
            // rather than the schema's table, so the codec maps it to one.
            if ((RecordTypeOf(relativePath, _release)
                 ?? new ContainerDocuments(_release, schemas).RecordTypeNamed(document.RecordType))
                is not { } recordType)
            {
                continue;
            }
            return new RecordIdentity(spelled, recordType, document.EditorId);
        }
        return null;
    }

    /// <summary>True when another record's document in this plugin's tree carries
    /// <paramref name="formKey"/>. The cheap half of <see cref="IdentityOf"/>, for a caller that
    /// needs no name and will not pay the codec read one costs.</summary>
    internal bool CarriesEmbedded(PluginCopyKey plugin, string formKey) =>
        OwnersUnder(Path.Combine(_modFolder, RootFor(plugin.Name)))
            .DocumentHolding(formKey) is not null;

    /// <summary>True when this plugin's tree holds <paramref name="formKey"/> at the working tree or
    /// at HEAD. Both, because a working-tree deletion does not free the ID until the next
    /// compile.</summary>
    public bool HoldsAtEitherRef(PluginCopyKey plugin, string formKey) =>
        HoldsNow(plugin, formKey) || HoldsAtRef(plugin, formKey, "HEAD");

    // Its own document's text has to declare the FormKey its name carries; otherwise another
    // record's document carries it inline, which the owner map answers.
    private bool HoldsNow(PluginCopyKey plugin, string formKey)
    {
        if (!FormKey.TryFactory(formKey, out var parsed)) return false;
        var sourceRoot = Path.Combine(_modFolder, RootFor(plugin.Name));
        if (!Directory.Exists(sourceRoot)) return false;

        // The header's document is the fixed root RecordData.json, and it declares a ModKey rather
        // than the FormKey the tree files it under, so no name or text carries that key.
        if (parsed.ToString().Equals(PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name)), StringComparison.OrdinalIgnoreCase))
            return File.Exists(HeaderDocumentIn(_modFolder, plugin.Name));

        foreach (var documentPath in DocumentsNaming(sourceRoot, parsed.ToString()))
        {
            if (ReadOrNull(documentPath) is not { } text) continue;
            if (RootStringIn(text, "FormKey") is { } declared
                && FormKey.TryFactory(declared, out var carried) && carried == parsed)
            {
                return true;
            }
        }
        return CarriesEmbedded(plugin, parsed.ToString());
    }

    // The committed set, read the same way the allocator reads it: a document's own FormKey, plus
    // every child inlined in it.
    private bool HoldsAtRef(PluginCopyKey plugin, string formKey, string gitRef) =>
        ReadAll(plugin, gitRef).Any(document =>
            document.FormKey.Equals(formKey, StringComparison.OrdinalIgnoreCase)
            || FormKeysIn(System.Text.Encoding.UTF8.GetBytes(document.Body))
                .Any(key => key.InAnEmbedSlot && key.FormKey.Equals(formKey, StringComparison.OrdinalIgnoreCase)));

    /// <summary>Where the tree puts the cell <paramref name="identity"/> names, or null when nothing
    /// holds it. The block levels are directories, which is why only the repository reads them back
    /// (ADR-0014 invariant 5).</summary>
    public CellPlacement? CellPlacementOf(PluginCopyKey plugin, RecordIdentity identity)
    {
        if (Locate(plugin, identity) is not { } unit) return null;

        // A worldspace's own top cell is inlined in the worldspace's document, so it has a worldspace
        // above it and no numbered block to be at.
        if (unit.IsEmbedded) return new CellPlacement(unit.OwnerFormKey, null, null, null, null, IsInterior: false);

        var path = new LayoutPath(unit.RelativePath);
        if (path.UnderGroupBlockLevels) return new CellPlacement(null, null, null, null, null, IsInterior: true);
        if (!path.UnderWorldspaceBlockLevels) return null;

        var worldspaceDocument = Path.Combine(_modFolder, path.WorldspaceDirectory, RecordDataFileName);
        if (FormKeyDeclaredBy(worldspaceDocument, _modFolder, plugin.Name) is not { } worldspace) return null;

        var (blockX, blockY) = Coordinates(path.BlockFolderName);
        var (subX, subY) = Coordinates(path.SubBlockFolderName);
        return new CellPlacement(worldspace, blockX, blockY, subX, subY, IsInterior: false);
    }

    // "<x>, <y>", as the whole-mod serializer names a block level's directory. Null coordinates for
    // any other name: a tree something else restructured says nothing about a grid.
    private static (int? X, int? Y) Coordinates(string folderName)
    {
        var parts = folderName.Split(',', 2);
        return parts.Length == 2
               && int.TryParse(parts[0].Trim(), System.Globalization.CultureInfo.InvariantCulture, out var x)
               && int.TryParse(parts[1].Trim(), System.Globalization.CultureInfo.InvariantCulture, out var y)
            ? (x, y)
            : (null, null);
    }

    private SourceUnit Unit(string fullPath, string ownerFormKey, string? ownerRecordType, bool isEmbedded) =>
        new(fullPath, Path.GetRelativePath(_modFolder, fullPath), ownerFormKey, ownerRecordType, isEmbedded);

    // Matches the FormKey alone, never the EditorID, which a caller may hold stale mid-rename. Every
    // directory-per-record group is searched, since a cell's directory sits in its own group's blocks
    // or inside its worldspace's.
    private string? FindOwnUnit(string sourceRoot, string formKey)
    {
        var suffix = FilesafeFormKey(formKey);
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
            if (!NameCarries(leaf, filesafeFormKey)) return null;
            var recordData = Path.Combine(entry, RecordDataFileName);
            return File.Exists(recordData) ? recordData : null;
        }

        return NameCarries(leaf, filesafeFormKey + JsonSuffix) ? entry : null;
    }

    // One listing per scan root turns a whole-mod pass from O(records × tree) into O(tree).
    private string[] EntriesUnder(string scanRoot)
    {
        if (_entriesByScanRoot.TryGetValue(scanRoot, out var cached)) return cached;
        var entries = Directory.EnumerateFileSystemEntries(scanRoot, "*", SearchOption.AllDirectories).ToArray();
        _entriesByScanRoot[scanRoot] = entries;
        return entries;
    }

    // Every verb that writes calls this: the listing, owner and file maps describe a tree this
    // repository has just changed, and reading them afterwards would answer about the tree as it stood.
    private void Forget()
    {
        _entriesByScanRoot.Clear();
        _ownersBySourceRoot.Clear();
        _filesByPluginAndRef.Clear();
    }

    private EmbeddedOwners OwnersUnder(string sourceRoot)
    {
        if (_ownersBySourceRoot.TryGetValue(sourceRoot, out var owners)) return owners;
        owners = new EmbeddedOwners(sourceRoot, _release);
        _ownersBySourceRoot[sourceRoot] = owners;
        return owners;
    }

    // Never exclusive owners of the file: it may be gone or locked since the listing named it.
    private static byte[]? BytesOrNull(string path)
    {
        try
        {
            return File.Exists(path) ? StripUtf8Bom(File.ReadAllBytes(path)) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
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
        // bear out is absence, never a stale owner. Read again at most once per repository (ADR-0009).
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
            && FormKeysIn(bytes).Any(k => k.InAnEmbedSlot && k.FormKey.Equals(formKey, StringComparison.Ordinal));

        // First document wins a FormKey two of them claim: that tree is corrupt, and refusing to answer
        // at all would take every unrelated record down with it.
        private static Dictionary<string, OwnerDocument> Scan(string sourceRoot, GameRelease release)
        {
            var byChild = new Dictionary<string, OwnerDocument>(StringComparer.Ordinal);
            if (!Directory.Exists(sourceRoot)) return byChild;

            var modFolder = Path.GetDirectoryName(Path.GetDirectoryName(sourceRoot))!;
            foreach (var documentPath in Directory.EnumerateFiles(sourceRoot, "*.json", SearchOption.AllDirectories))
            {
                if (CarriesNoRecord(documentPath)) continue;
                if (DocumentBytes(documentPath) is not { } bytes) continue;

                var keys = FormKeysIn(bytes);
                if (keys.FirstOrDefault(k => k.AtRoot).FormKey is not { } root) continue;

                // A null type is an answer, not a skip: a path-ambiguous group's documents name their
                // own type, and dropping them leaves every child they carry unlocatable.
                var recordType = RecordTypeOf(Path.GetRelativePath(modFolder, documentPath), release);

                var owner = new OwnerDocument(documentPath, root, recordType);
                foreach (var (childFormKey, _, inAnEmbedSlot) in keys)
                {
                    if (inAnEmbedSlot) byChild.TryAdd(childFormKey, owner);
                }
            }
            return byChild;
        }

        // Never exclusive owners of the file: it may be gone or locked since the listing.
        private static byte[]? DocumentBytes(string path)
        {
            try
            {
                return File.Exists(path) ? StripUtf8Bom(File.ReadAllBytes(path)) : null;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return null;
            }
        }
    }

    // The codec writes a link as a bare string and a child as an object with a FormKey of its
    // own, so the slot a key sits under tells the two apart. Malformed text yields what it read.
    private static List<(string FormKey, bool AtRoot, bool InAnEmbedSlot)> FormKeysIn(byte[] bytes)
    {
        var found = new List<(string, bool, bool)>();
        var reader = new Utf8JsonReader(bytes);

        // The member that opened the container at each depth; null where an array element or the
        // document's own root opened it.
        var openedBy = new List<string?>();
        string? pendingMember = null;
        var atFormKey = false;
        var keyDepth = 0;
        try
        {
            while (reader.Read())
            {
                switch (reader.TokenType)
                {
                    case JsonTokenType.PropertyName:
                        atFormKey = reader.ValueTextEquals(FormKeyPropertyName);
                        keyDepth = reader.CurrentDepth;
                        pendingMember = reader.GetString();
                        continue;
                    case JsonTokenType.StartObject or JsonTokenType.StartArray:
                        OpenedAt(openedBy, reader.CurrentDepth, pendingMember);
                        break;
                    case JsonTokenType.String when atFormKey:
                        found.Add((reader.GetString()!, keyDepth == 1, UnderAnEmbedSlot(openedBy, keyDepth)));
                        break;
                }
                atFormKey = false;
                pendingMember = null;
            }
        }
        catch (JsonException)
        {
            // Caught mid-save, or hand-edited into something that is not a document.
        }
        return found;
    }

    private static void OpenedAt(List<string?> openedBy, int depth, string? member)
    {
        while (openedBy.Count <= depth) openedBy.Add(null);
        openedBy[depth] = member;
    }

    // A child record's own FormKey sits inside the slot its container embeds it in, at any depth: a
    // worldspace embeds its TopCell, which embeds its placed references.
    private static bool UnderAnEmbedSlot(List<string?> openedBy, int keyDepth)
    {
        for (var depth = 0; depth < keyDepth && depth < openedBy.Count; depth++)
        {
            if (openedBy[depth] is { } member && EmbedSlotNames.Contains(member)) return true;
        }
        return false;
    }

    private static readonly HashSet<string> EmbedSlotNames =
        ContainerChildFields.EmbeddedSlots.Select(slot => slot.Slot).ToHashSet(StringComparer.Ordinal);

    private static ReadOnlySpan<byte> FormKeyPropertyName => "FormKey"u8;
}
