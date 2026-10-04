using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

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
    string? ParentWorldspace, int? BlockX, int? BlockY, int? SubX, int? SubY, bool IsInterior)
{
    // Every game's GRUP layout: a sub-block spans 8 cells a side, and a block 4 sub-blocks.
    private const int CellsPerSubBlock = 8;
    private const int SubBlocksPerBlock = 4;

    /// <summary>Where the exterior cell at grid (<paramref name="x"/>, <paramref name="y"/>) of
    /// <paramref name="worldspace"/> sits.</summary>
    public static CellPlacement AtGrid(string worldspace, int x, int y)
    {
        var (subX, subY) = (FloorDiv(x, CellsPerSubBlock), FloorDiv(y, CellsPerSubBlock));
        return new(worldspace, FloorDiv(subX, SubBlocksPerBlock), FloorDiv(subY, SubBlocksPerBlock), subX, subY, IsInterior: false);
    }

    private static int FloorDiv(int value, int by) => (int)Math.Floor(value / (double)by);
}

/// <summary>Resolution: which document in the tree holds a record. The listing memo and the tree
/// scans are the repository's own per-operation state, and nothing outside it holds either.</summary>
public sealed partial class SourceRepository
{
    // One repository is one operation, so all live and die with it: the next Track, compile or edit
    // looks at the tree again, never trusting a file timestamp (ADR-0003).
    private readonly Dictionary<string, string[]> _entriesByScanRoot = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TreeScan> _scansBySourceRoot = new(StringComparer.Ordinal);
    private readonly Dictionary<(string SourceRoot, string FormKey), TreeScan> _scansByKey = [];
    private readonly Dictionary<(string Plugin, string FormKey), string> _foundByText = [];

    /// <summary>The unit holding <paramref name="identity"/>, as the document it is and the facts about
    /// it. Null when no document in the tree holds it, which is a refusal to the caller.</summary>
    public HoldingUnit? UnitHolding(PluginAddress plugin, RecordIdentity identity) =>
        Locate(plugin, identity) is { } unit
            ? new HoldingUnit(
                unit.RelativePath, unit.IsEmbedded, unit.OwnerFormKey, unit.OwnerRecordType,
                unit.IsDirectoryPerRecord)
            : null;

    /// <summary>The document holding <paramref name="identity"/>, and whether that document is another
    /// record's. The one place an identity becomes a path, which is why it stays here.</summary>
    internal SourceUnit? Locate(PluginAddress plugin, RecordIdentity identity) => Resolve(plugin, identity, byText: true);

    /// <summary><see cref="Locate"/> for a write: a document found by its
    /// text earlier in this operation still answers, and no other document is read, so a record no
    /// document holds is placed from its identity alone.</summary>
    internal SourceUnit? LocateToPlace(PluginAddress plugin, RecordIdentity identity) =>
        Resolve(plugin, identity, byText: false);

    private SourceUnit? Resolve(PluginAddress plugin, RecordIdentity identity, bool byText)
    {
        if (identity.RecordType == PluginHeader.RecordType)
        {
            return Unit(
                HeaderDocumentIn(_modFolder, plugin.Name), identity.FormKey, identity.RecordType, isEmbedded: false);
        }

        // A flat record's own document is under its group folder, and where a new one would go is
        // computed from its identity.
        if (ComputedFlatPath(plugin, identity) is { } computed)
        {
            return Unit(
                OwnDocumentUnder([PathShape.DirectoryOf(computed)], plugin.Name, identity.FormKey, byText) ?? computed,
                identity.FormKey, identity.RecordType, isEmbedded: false);
        }

        // Only a directory-per-record type (Cell, Worldspace) can have a directory of its own; a type
        // with no group of its own is always embedded, so nothing is scanned for it.
        var sourceRoot = Path.Combine(_modFolder, RootFor(plugin.Name));
        if (RecordTypeDispatch.For(_release).GroupFolderNameFor(identity.RecordType) is not null
            && FindOwnUnit(sourceRoot, plugin.Name, identity.FormKey, byText) is { } own)
        {
            return Unit(own, identity.FormKey, identity.RecordType, isEmbedded: false);
        }

        // Nothing of its own, so it is inlined in another record's document, which the owner map names.
        if (DocumentHolding(sourceRoot, identity.FormKey) is not { } owner) return null;

        return Unit(owner.FullPath, owner.FormKey, owner.RecordType, isEmbedded: true);
    }

    /// <summary>Which record the tree holds at <paramref name="formKey"/> — one with a document of
    /// its own, an embedded child, or the header — or null when nothing carries it.</summary>
    public RecordIdentity? IdentityOf(
        PluginAddress plugin, string formKey, IReadOnlyDictionary<string, RecordTableSchema> schemas)
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
        if (DocumentHolding(sourceRoot, spelled) is not { } owner) return null;
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
    public string? UnreadableDocumentFor(PluginAddress plugin, string formKey)
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

    // A record with a document of its own, found as Locate finds it. A name the text contradicts is
    // stale, and the record it claims is elsewhere or gone.
    private RecordIdentity? OwnDocumentIdentity(
        string sourceRoot, string pluginFileName, FormKey formKey, string spelled,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        var identified = IdentitiesIn(DocumentsNaming(sourceRoot, spelled), pluginFileName, formKey, spelled, schemas);
        if (identified.Count == 0)
        {
            identified = IdentitiesIn(
                DocumentsDeclaring(sourceRoot, spelled), pluginFileName, formKey, spelled, schemas);
            RememberFoundByText(pluginFileName, spelled, [.. identified.Select(i => i.Path)]);
        }

        return OneDocumentPerFormKey.TheOne([.. identified.Select(i => i.Path)], spelled, _modFolder) is { } path
            ? identified.Single(i => i.Path == path).Identity
            : null;
    }

    private List<(string Path, RecordIdentity Identity)> IdentitiesIn(
        IEnumerable<string> documentPaths, string pluginFileName, FormKey formKey, string spelled,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        var identified = new List<(string, RecordIdentity)>();
        foreach (var documentPath in documentPaths)
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
            identified.Add((documentPath, new RecordIdentity(spelled, recordType, document.EditorId)));
        }
        return identified;
    }

    private string? ComputedFlatPath(PluginAddress plugin, RecordIdentity identity)
    {
        try
        {
            return Path.Combine(
                _modFolder,
                FlatPathFor(plugin.Name, identity.RecordType, identity.FormKey, identity.EditorId, _release));
        }
        catch (NotSupportedException)
        {
            // Not flat: a container, or a child with no top-level group of its own.
            return null;
        }
    }

    // The one named for the FormKey, else one whose text declares it under any other name: a hand
    // move can rename a document, and the name alone reads a live record as deleted.
    private string? OwnDocumentUnder(
        IReadOnlyList<string> scanRoots, string pluginFileName, string formKey, bool byText)
    {
        var roots = scanRoots.Where(Directory.Exists).ToList();
        var documents = roots
            .SelectMany(root => DocumentsNaming(root, formKey))
            .Where(File.Exists)
            .ToList();
        if (documents.Count == 0 && RememberedFoundByText(pluginFileName, formKey) is { } found)
            documents = [found];
        if (documents.Count == 0 && byText)
        {
            documents = [.. DocumentsDeclaring(Path.Combine(_modFolder, RootFor(pluginFileName)), formKey)
                .Where(document => roots.Exists(root => IsUnder(root, document)))];
            RememberFoundByText(pluginFileName, formKey, documents);
        }

        return OneDocumentPerFormKey.TheOne(documents, formKey, _modFolder);
    }

    // Every read that finds a document by its text remembers it, so no put later in this operation
    // misses it by name and writes a second document beside it.
    private List<string> RememberFoundByText(string pluginFileName, string formKey, List<string> documents)
    {
        if (documents.Count == 1) _foundByText[(pluginFileName, Canonical(formKey))] = documents[0];
        return documents;
    }

    private string? RememberedFoundByText(string pluginFileName, string formKey) =>
        _foundByText.TryGetValue((pluginFileName, Canonical(formKey)), out var found) && File.Exists(found) ? found : null;

    private static string Canonical(string formKey) =>
        FormKey.TryFactory(formKey, out var parsed) ? parsed.ToString() : formKey;

    private static bool IsUnder(string directory, string path) =>
        path.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.Ordinal);


    /// <summary>True when another record's document in this plugin's tree carries
    /// <paramref name="formKey"/>. The cheap half of <see cref="IdentityOf"/>, for a caller that
    /// needs no name and will not pay the codec read one costs.</summary>
    internal bool CarriesEmbedded(PluginAddress plugin, string formKey) =>
        DocumentHolding(Path.Combine(_modFolder, RootFor(plugin.Name)), formKey) is not null;

    /// <summary>True when this plugin's tree holds <paramref name="formKey"/> at the working tree or
    /// at HEAD. Both, because a working-tree deletion does not free the ID until the next
    /// compile.</summary>
    public bool HoldsAtEitherRef(PluginAddress plugin, string formKey) =>
        HoldsNow(plugin, formKey) || HoldsAtRef(plugin, formKey, "HEAD");

    // Its own document is found as Locate finds it and has to declare the key; otherwise another
    // record's document carries it inline, which the tree scan answers.
    private bool HoldsNow(PluginAddress plugin, string formKey)
    {
        if (!FormKey.TryFactory(formKey, out var parsed)) return false;
        var sourceRoot = Path.Combine(_modFolder, RootFor(plugin.Name));
        if (!Directory.Exists(sourceRoot)) return false;

        // The header's document is the fixed root RecordData.json, and it declares a ModKey rather
        // than the FormKey the tree files it under, so no name or text carries that key.
        if (parsed.ToString().Equals(PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name)), StringComparison.OrdinalIgnoreCase))
            return File.Exists(HeaderDocumentIn(_modFolder, plugin.Name));

        var spelled = parsed.ToString();
        return DocumentsNaming(sourceRoot, spelled).Any(document => Declares(document, parsed))
               || RememberFoundByText(plugin.Name, spelled, DocumentsDeclaring(sourceRoot, spelled)).Count > 0
               || CarriesEmbedded(plugin, spelled);
    }

    private static bool Declares(string documentPath, FormKey formKey) =>
        ReadOrNull(documentPath) is { } text
        && RootStringIn(text, "FormKey") is { } declared
        && FormKey.TryFactory(declared, out var carried)
        && carried == formKey;

    // The committed set, read the same way the allocator reads it: a document's own FormKey, plus
    // every child inlined in it.
    private bool HoldsAtRef(PluginAddress plugin, string formKey, string gitRef) =>
        ReadAll(plugin, gitRef).Any(document =>
            document.FormKey.Equals(formKey, StringComparison.OrdinalIgnoreCase)
            || FormKeysIn(System.Text.Encoding.UTF8.GetBytes(document.Body), _release)
                .Any(key => key.InAnEmbedSlot && key.FormKey.Equals(formKey, StringComparison.OrdinalIgnoreCase)));

    /// <summary>Where the tree puts the cell <paramref name="identity"/> names, or null when nothing
    /// holds it. Only the repository reads block directories back (ADR-0014). A
    /// worldspace document declaring no FormKey throws.</summary>
    public CellPlacement? CellPlacementOf(PluginAddress plugin, RecordIdentity identity)
    {
        if (Locate(plugin, identity) is not { } unit) return null;

        // A worldspace's own top cell is inlined in the worldspace's document, so it has a worldspace
        // above it and no numbered block to be at.
        if (unit.IsEmbedded) return new CellPlacement(unit.OwnerFormKey, null, null, null, null, IsInterior: false);

        var path = new LayoutPath(unit.RelativePath);
        if (path.UnderGroupBlockLevels) return new CellPlacement(null, null, null, null, null, IsInterior: true);
        if (!path.UnderWorldspaceBlockLevels) return null;

        var worldspaceDocument = Path.Combine(_modFolder, path.WorldspaceDirectory, RecordDataFileName);
        var worldspace = FormKeyDeclaredBy(worldspaceDocument, plugin.Name)
            ?? throw new UnreadableSourceDocumentException(worldspaceDocument, "it declares no FormKey, so the worldspace its exterior cells sit in is unknown");

        var (blockX, blockY) = Coordinates(path.BlockFolderName);
        var (subX, subY) = Coordinates(path.SubBlockFolderName);
        return new CellPlacement(worldspace, blockX, blockY, subX, subY, IsInterior: false);
    }

    /// <summary>The worldspace whose subtree carries the cell <paramref name="identity"/> names; null for
    /// an interior cell, and for a cell the plugin does not hold. A tree that files an exterior cell
    /// outside every worldspace's blocks refuses with the reader's words.</summary>
    public string? WorldspaceOf(PluginAddress plugin, RecordIdentity identity)
    {
        if (Locate(plugin, identity) is null) return null;
        if (CellPlacementOf(plugin, identity) is { } placement) return placement.ParentWorldspace;

        throw new UnreadableSourceDocumentException(
            $"{identity.FormKey} sits under neither a cell group nor a worldspace's blocks, so the tree names no worldspace for it.");
    }

    /// <summary>The exterior cell this plugin's tree holds at grid (<paramref name="x"/>,
    /// <paramref name="y"/>) of <paramref name="worldspace"/>, or null when it holds none there.</summary>
    public SourceDocument? GetCellAt(
        PluginAddress plugin, string worldspace, int x, int y, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        CellFormKeyAt(plugin, worldspace, x, y) is { } formKey ? Get(plugin, formKey, schemas) : null;

    private string? CellFormKeyAt(PluginAddress plugin, string worldspace, int x, int y)
    {
        if (FindOwnUnit(Path.Combine(_modFolder, RootFor(plugin.Name)), plugin.Name, worldspace) is not { } worldspaceDocument)
            return null;
        var placement = CellPlacement.AtGrid(worldspace, x, y);
        var subBlock = Path.Combine(
            PathShape.DirectoryOf(worldspaceDocument),
            BlockLevelName(placement.BlockX, placement.BlockY), BlockLevelName(placement.SubX, placement.SubY));
        if (!Directory.Exists(subBlock)) return null;
        foreach (var document in Directory.EnumerateDirectories(subBlock).Select(cell => Path.Combine(cell, RecordDataFileName)))
        {
            if (!File.Exists(document)) continue;
            var text = File.ReadAllText(document);
            JsonNode? cell;
            try
            {
                cell = JsonNode.Parse(text);
            }
            catch (JsonException ex)
            {
                throw new UnreadableSourceDocumentException(document, $"it is no JSON document: {ex.Message.TrimEnd('.')}");
            }
            if (cell is JsonObject held && PlacedCell.Grid(held) == (x, y)) return FormKeyDeclaredIn(text, document, plugin.Name);
        }
        return null;
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
    private string? FindOwnUnit(string sourceRoot, string pluginFileName, string formKey, bool byText = true) =>
        OwnDocumentUnder(
            [.. RecordTypeDispatch.For(_release).DirectoryPerRecordFolderNames
                .Select(groupFolder => Path.Combine(sourceRoot, groupFolder))],
            pluginFileName, formKey, byText);

    // One listing per scan root turns a whole-mod pass from O(records × tree) into O(tree).
    private string[] EntriesUnder(string scanRoot)
    {
        if (_entriesByScanRoot.TryGetValue(scanRoot, out var cached)) return cached;
        var entries = _entriesByScanRoot.FirstOrDefault(listed => IsUnder(listed.Key, scanRoot)).Value is { } above
            ? [.. above.Where(entry => IsUnder(scanRoot, entry))]
            : Directory.EnumerateFileSystemEntries(scanRoot, "*", SearchOption.AllDirectories).ToArray();
        _entriesByScanRoot[scanRoot] = entries;
        return entries;
    }

    // Every verb that writes calls this: the listing, owner and file maps describe a tree this
    // repository has just changed. A document found by its text stays found until a write moves it.
    private void Forget()
    {
        _entriesByScanRoot.Clear();
        _scansBySourceRoot.Clear();
        _scansByKey.Clear();
        foreach (var gone in _foundByText.Where(found => !File.Exists(found.Value)).Select(found => found.Key).ToList())
            _foundByText.Remove(gone);
        _filesByPlugin.Clear();
    }

    // Past a few keys, one whole scan costs less than the next keys' scans would.
    private const int KeyScansBeforeAWholeScan = 3;

    private TreeScan.OwnerDocument? DocumentHolding(string sourceRoot, string formKey) =>
        ScanFor(sourceRoot, formKey).DocumentHolding(formKey);

    private List<string> DocumentsDeclaring(string sourceRoot, string formKey) =>
        ScanFor(sourceRoot, formKey).DocumentsDeclaring(formKey);

    private TreeScan ScanFor(string sourceRoot, string formKey)
    {
        if (_scansBySourceRoot.TryGetValue(sourceRoot, out var whole)) return whole;
        if (_scansByKey.TryGetValue((sourceRoot, formKey), out var keyed)) return keyed;
        var listed = Directory.Exists(sourceRoot) ? EntriesUnder(sourceRoot) : [];
        if (_scansByKey.Keys.Count(key => key.SourceRoot == sourceRoot) < KeyScansBeforeAWholeScan)
            return _scansByKey[(sourceRoot, formKey)] = new TreeScan(sourceRoot, _release, formKey, listed);
        return _scansBySourceRoot[sourceRoot] = new TreeScan(sourceRoot, _release, onlyKey: null, listed);
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

    // What the documents under one plugin's source root declare, from one token scan: the record at
    // each one's root, and the children it carries inline. A scan for one key reads only the
    // documents that may hold it.
    private sealed class TreeScan
    {
        // The document a child sits inside: its file, the record at its root, and that record's type
        // where the path decides it — null means the document names its own.
        internal readonly record struct OwnerDocument(string FullPath, string FormKey, string? RecordType);

        private readonly record struct Holders(List<string> Declaring, List<OwnerDocument> Carrying);

        private sealed record DocumentKeys(byte[] Bytes, HashSet<string> AtRoot, HashSet<string> Embedded);

        private readonly string _sourceRoot;
        private readonly GameRelease _release;
        private readonly byte[]? _onlyKey;
        private Dictionary<string, List<OwnerDocument>> _byChild = new(StringComparer.Ordinal);
        private Dictionary<string, List<string>> _byRoot = new(StringComparer.Ordinal);
        private bool _rescanned;
        private readonly Dictionary<string, DocumentKeys> _keysByDocument = new(StringComparer.Ordinal);

        internal TreeScan(string sourceRoot, GameRelease release, string? onlyKey, IEnumerable<string> listed)
        {
            (_sourceRoot, _release) = (sourceRoot, release);
            _onlyKey = onlyKey is null ? null : System.Text.Encoding.UTF8.GetBytes(onlyKey);
            Scan(listed);
        }

        internal OwnerDocument? DocumentHolding(string formKey)
        {
            var carrying = HoldersOf(formKey).Carrying;
            return OneDocumentPerFormKey.TheOne([.. carrying.Select(owner => owner.FullPath)], formKey, ModFolder) is { } path
                ? carrying.Single(owner => owner.FullPath == path)
                : null;
        }

        internal List<string> DocumentsDeclaring(string formKey) => HoldersOf(formKey).Declaring;

        // Every answer is checked against the document's current text, so a stale entry reads as
        // absence. A key no document bears out, at its root or inline, is read again once per scan.
        private Holders HoldersOf(string formKey)
        {
            var holders = BorneOut(formKey);
            if (holders.Declaring.Count > 0 || holders.Carrying.Count > 0 || _rescanned) return holders;
            _rescanned = true;
            Scan(Directory.Exists(_sourceRoot) ? Directory.EnumerateFiles(_sourceRoot, "*.json", SearchOption.AllDirectories) : []);
            return BorneOut(formKey);
        }

        private Holders BorneOut(string formKey) => new(
            [.. _byRoot.GetValueOrDefault(formKey, []).Where(document => KeysOf(document)?.AtRoot.Contains(formKey) == true)],
            [.. _byChild.GetValueOrDefault(formKey, []).Where(owner => KeysOf(owner.FullPath)?.Embedded.Contains(formKey) == true)]);

        private string ModFolder => PathShape.DirectoryOf(PathShape.DirectoryOf(_sourceRoot));

        // One owner is verified for each of its many children, so its tokens are reused while its
        // bytes are unchanged.
        private DocumentKeys? KeysOf(string documentPath)
        {
            if (DocumentBytes(documentPath) is not { } bytes) return null;
            if (_keysByDocument.TryGetValue(documentPath, out var known) && known.Bytes.AsSpan().SequenceEqual(bytes))
                return known;

            var keys = FormKeysIn(bytes, _release);
            return _keysByDocument[documentPath] = new DocumentKeys(
                bytes,
                [.. keys.Where(k => k.AtRoot).Select(k => k.FormKey)],
                [.. keys.Where(k => k.InAnEmbedSlot).Select(k => k.FormKey)]);
        }

        private void Scan(IEnumerable<string> listed)
        {
            var byChild = new Dictionary<string, List<OwnerDocument>>(StringComparer.Ordinal);
            var byRoot = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            foreach (var documentPath in listed)
            {
                if (CarriesNoRecord(documentPath)) continue;
                if (DocumentBytes(documentPath) is not { } bytes) continue;
                if (_onlyKey is { } key && !MaySpell(bytes, key)) continue;

                var keys = FormKeysIn(bytes, _release);
                if (keys.FirstOrDefault(k => k.AtRoot).FormKey is not { } root) continue;

                if (!byRoot.TryGetValue(root, out var declaring)) byRoot[root] = declaring = [];
                declaring.Add(documentPath);

                // A null type is an answer, not a skip: a path-ambiguous group's documents name
                // their own type, and dropping them leaves every child they carry unlocatable.
                var recordType = RecordTypeOf(Path.GetRelativePath(ModFolder, documentPath), _release);

                var owner = new OwnerDocument(documentPath, root, recordType);
                foreach (var (childFormKey, _, inAnEmbedSlot) in keys)
                {
                    if (!inAnEmbedSlot) continue;
                    if (!byChild.TryGetValue(childFormKey, out var owners)) byChild[childFormKey] = owners = [];
                    owners.Add(owner);
                }
            }
            (_byChild, _byRoot) = (byChild, byRoot);
        }

        // JSON spells a FormKey other than literally only through a \u escape: no plugin's file name
        // holds a quote, a backslash, a slash or a control character, the only others it escapes.
        private static bool MaySpell(byte[] document, byte[] formKey) =>
            document.AsSpan().IndexOf(formKey) >= 0 || document.AsSpan().IndexOf(@"\u"u8) >= 0;

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
    private static List<(string FormKey, bool AtRoot, bool InAnEmbedSlot)> FormKeysIn(byte[] bytes, GameRelease release)
    {
        var embeddedSlotNames = ContainerSlots.For(release).EmbeddedSlotsOf(null).ToHashSet(StringComparer.Ordinal);
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
                        var formKey = reader.GetString()
                            ?? throw new InvalidOperationException("Expected a JSON string value to read a non-null string.");
                        found.Add((formKey, keyDepth == 1, UnderAnEmbedSlot(openedBy, keyDepth, embeddedSlotNames)));
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
    private static bool UnderAnEmbedSlot(List<string?> openedBy, int keyDepth, HashSet<string> embeddedSlotNames)
    {
        for (var depth = 0; depth < keyDepth && depth < openedBy.Count; depth++)
        {
            if (openedBy[depth] is { } member && embeddedSlotNames.Contains(member)) return true;
        }
        return false;
    }

    private static ReadOnlySpan<byte> FormKeyPropertyName => "FormKey"u8;
}
