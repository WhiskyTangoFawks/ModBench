using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>The file holding a record: found on disk for a container or embedded child, computed for
/// a flat record. A null <see cref="SourceUnit.OwnerRecordType"/> means the document names its own
/// type.</summary>
internal readonly record struct SourceUnit(
    string FullPath, string RelativePath, string OwnerFormKey, string? OwnerRecordType, bool IsEmbedded)
{
    /// <summary>A container's own field file, not a flat file.</summary>
    internal bool IsDirectoryPerRecord =>
        Path.GetFileName(FullPath).Equals(SourceRepositoryLayout.RecordDataFileName, StringComparison.Ordinal);
}

/// <summary>Which document in the tree holds a record, and what that document says. The listing memo
/// and the tree scans are this locator's own per-operation state, and nothing outside it holds either.</summary>
internal sealed class SourceRepositoryLocator(string modFolder, GameRelease release)
{
    private readonly string _modFolder = modFolder;
    private readonly GameRelease _release = release;
    private readonly Dictionary<string, PluginSourceFiles> _filesByPlugin = new(StringComparer.Ordinal);

    // One locator is one operation, so all live and die with it: the next Track, compile or edit
    // looks at the tree again, never trusting a file timestamp (ADR-0003).
    private readonly Dictionary<string, string[]> _entriesByScanRoot = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TreeScan> _scansBySourceRoot = new(StringComparer.Ordinal);
    private readonly Dictionary<(string SourceRoot, string FormKey), TreeScan> _scansByKey = [];
    private readonly Dictionary<(string Plugin, string FormKey), string> _foundByText = [];

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
                SourceRepositoryLayout.HeaderDocumentIn(_modFolder, plugin.Name), identity.FormKey, identity.RecordType, isEmbedded: false);
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
        var sourceRoot = Path.Combine(_modFolder, SourceRepositoryLayout.RootFor(plugin.Name));
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
    internal RecordIdentity? IdentityOf(
        PluginAddress plugin, string formKey, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        // A malformed FormKey is a caller's raw input, not a broken tree: it names nothing and throws
        // nothing.
        if (!FormKey.TryFactory(formKey, out var parsed)) return null;
        var spelled = parsed.ToString();

        var sourceRoot = Path.Combine(_modFolder, SourceRepositoryLayout.RootFor(plugin.Name));
        if (!Directory.Exists(sourceRoot)) return null;

        // The header's document declares a ModKey rather
        // than the FormKey the index files it under, so no name or text in the tree carries that key.
        if (spelled.Equals(PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name)), StringComparison.OrdinalIgnoreCase))
        {
            return File.Exists(SourceRepositoryLayout.HeaderDocumentIn(_modFolder, plugin.Name))
                ? new RecordIdentity(spelled, PluginHeader.RecordType, null)
                : null;
        }

        if (OwnDocumentIdentity(sourceRoot, plugin.Name, parsed, spelled, schemas) is { } own) return own;

        // Nothing of its own, so another record's document carries it inline, and the codec reads its
        // type and name off that document's text.
        if (DocumentHolding(sourceRoot, spelled) is not { } owner) return null;
        if (DocumentText.BytesOrNull(owner.FullPath) is not { } ownerBytes) return null;
        if (new ContainerDocuments(_release, schemas).EmbeddedIdentity(owner.RecordType, ownerBytes, spelled)
            is not { } child)
        {
            return null;
        }

        return new RecordIdentity(spelled, child.RecordType, child.EditorId);
    }

    /// <summary>The record at <paramref name="formKey"/> and the document carrying it, read from <paramref name="text"/>
    /// rather than that document's file, which is only found. Null when nothing in the tree holds it.</summary>
    internal (RecordIdentity Record, SourceDocument Carrying)? CarryingFromText(
        PluginAddress plugin, string formKey, string text, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (!FormKey.TryFactory(formKey, out var parsed)) return null;
        var spelled = parsed.ToString();
        var sourceRoot = Path.Combine(_modFolder, SourceRepositoryLayout.RootFor(plugin.Name));
        if (!Directory.Exists(sourceRoot)) return null;

        if (spelled.Equals(PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name)), StringComparison.OrdinalIgnoreCase))
        {
            if (!File.Exists(SourceRepositoryLayout.HeaderDocumentIn(_modFolder, plugin.Name))) return null;
            var header = new SourceDocument(spelled, PluginHeader.RecordType, null, text);
            return (header.Identity, header);
        }

        var named = DocumentsNaming(sourceRoot, spelled).Where(File.Exists).ToList();
        if (OneDocumentPerFormKey.TheOne(named.Count > 0 ? named : DocumentsDeclaring(sourceRoot, spelled), spelled, _modFolder) is { } own)
        {
            var document = DeclaredIn(own, text, plugin.Name, schemas);
            if (!FormKey.TryFactory(document.FormKey, out var declared) || declared != parsed)
                throw new UnreadableSourceDocumentException($"The text given for {Path.GetRelativePath(_modFolder, own)} declares {document.FormKey}, not {spelled}.");
            return (document.Identity with { FormKey = spelled }, document);
        }

        if (DocumentHolding(sourceRoot, spelled) is not { } owner) return null;
        var carrying = DeclaredIn(owner.FullPath, text, plugin.Name, schemas);
        var child = new ContainerDocuments(_release, schemas).EmbeddedIdentity(owner.RecordType, Encoding.UTF8.GetBytes(text), spelled)
            ?? throw new UnreadableSourceDocumentException(
                $"The text given for {Path.GetRelativePath(_modFolder, owner.FullPath)} does not carry {spelled}.");
        return (new RecordIdentity(spelled, child.RecordType, child.EditorId), carrying);
    }

    private SourceDocument DeclaredIn(
        string documentPath, string text, string pluginFileName, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        var relativePath = Path.GetRelativePath(_modFolder, documentPath);
        if (NotADocument(text) is { } why)
            throw new UnreadableSourceDocumentException($"The text given for {relativePath} is not a readable document: {why}");
        var document = DocumentAt(relativePath, text, pluginFileName)
            ?? throw new UnreadableSourceDocumentException($"The text given for {relativePath} names no record.");
        var recordType = SourceRepositoryLayout.RecordTypeOf(relativePath, _release)
            ?? new ContainerDocuments(_release, schemas).RecordTypeNamed(document.RecordType)
            ?? throw new UnreadableSourceDocumentException($"The text given for {relativePath} names no record type.");
        return document with { RecordType = recordType };
    }

    /// <summary>The reader's own words for a document whose name carries <paramref name="formKey"/>
    /// and whose text is not one; null when the tree names no such document.</summary>
    internal string? UnreadableDocumentFor(PluginAddress plugin, string formKey)
    {
        if (!FormKey.TryFactory(formKey, out var parsed)) return null;
        var sourceRoot = Path.Combine(_modFolder, SourceRepositoryLayout.RootFor(plugin.Name));
        if (!Directory.Exists(sourceRoot)) return null;

        foreach (var documentPath in DocumentsNaming(sourceRoot, parsed.ToString()))
        {
            if (DocumentText.ReadOrNull(documentPath) is { } text && NotADocument(text) is { } why) return why;
        }
        return null;
    }

    // Its root has to be a JSON object before any member of it can be read; anything else is a file
    // something else wrote over the document, and the reader's message is the whole diagnosis.
    internal static string? NotADocument(string text)
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
        // Computed once rather than per entry: FilesafeFormKey reparses the FormKey on every call.
        var filesafe = SourceRepositoryLayout.FilesafeFormKey(spelled);
        foreach (var entry in EntriesUnder(sourceRoot))
        {
            var leaf = Path.GetFileName(entry);
            if (!SourceRepositoryLayout.NameCarries(leaf, filesafe) && !SourceRepositoryLayout.NameCarries(leaf, filesafe + SourceRepositoryLayout.JsonSuffix)) continue;

            yield return Directory.Exists(entry) ? Path.Combine(entry, SourceRepositoryLayout.RecordDataFileName) : entry;
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
            if (DocumentText.ReadOrNull(documentPath) is not { } text) continue;
            var relativePath = Path.GetRelativePath(_modFolder, documentPath);
            if (DocumentAt(relativePath, text, pluginFileName) is not { } document) continue;
            if (!FormKey.TryFactory(document.FormKey, out var declared) || declared != formKey) continue;

            // A path-ambiguous group's document names its own type, and that name is the codec's
            // rather than the schema's table, so the codec maps it to one.
            if ((SourceRepositoryLayout.RecordTypeOf(relativePath, _release)
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
                SourceRepositoryLayout.FlatPathFor(plugin.Name, identity.RecordType, identity.FormKey, identity.EditorId, _release));
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
            documents = [.. DocumentsDeclaring(Path.Combine(_modFolder, SourceRepositoryLayout.RootFor(pluginFileName)), formKey)
                .Where(document => roots.Exists(root => IsUnder(root, document)))];
            RememberFoundByText(pluginFileName, formKey, documents);
        }

        return OneDocumentPerFormKey.TheOne(documents, formKey, _modFolder);
    }

    // Every read that finds a document by its text remembers it, so no put later in this operation
    // misses it by name and writes a second document beside it.
    private void RememberFoundByText(string pluginFileName, string formKey, List<string> documents)
    {
        if (documents.Count == 1) _foundByText[(pluginFileName, Canonical(formKey))] = documents[0];
    }

    private string? RememberedFoundByText(string pluginFileName, string formKey) =>
        _foundByText.TryGetValue((pluginFileName, Canonical(formKey)), out var found) && File.Exists(found) ? found : null;

    private static string Canonical(string formKey) =>
        FormKey.TryFactory(formKey, out var parsed) ? parsed.ToString() : formKey;

    private static bool IsUnder(string directory, string path) =>
        path.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.Ordinal);

    /// <summary>Where the tree puts the cell <paramref name="identity"/> names, or null when nothing
    /// holds it. Only the repository reads block directories back (ADR-0014). A
    /// worldspace document declaring no FormKey throws.</summary>
    internal CellPlacement? CellPlacementOf(PluginAddress plugin, RecordIdentity identity)
    {
        if (Locate(plugin, identity) is not { } unit) return null;

        // A worldspace's own top cell is inlined in the worldspace's document, so it has a worldspace
        // above it and no numbered block to be at.
        if (unit.IsEmbedded) return new CellPlacement(unit.OwnerFormKey, null, null, null, null, IsInterior: false);

        var path = new LayoutPath(unit.RelativePath);
        if (path.UnderGroupBlockLevels) return new CellPlacement(null, null, null, null, null, IsInterior: true);
        if (!path.UnderWorldspaceBlockLevels) return null;

        var worldspaceDocument = Path.Combine(_modFolder, path.WorldspaceDirectory, SourceRepositoryLayout.RecordDataFileName);
        var worldspace = DocumentText.FormKeyDeclaredBy(worldspaceDocument, plugin.Name)
            ?? throw new UnreadableSourceDocumentException(worldspaceDocument, "it declares no FormKey, so the worldspace its exterior cells sit in is unknown");

        var (blockX, blockY) = Coordinates(path.BlockFolderName);
        var (subX, subY) = Coordinates(path.SubBlockFolderName);
        return new CellPlacement(worldspace, blockX, blockY, subX, subY, IsInterior: false);
    }

    internal string? CellFormKeyAt(PluginAddress plugin, string worldspace, int x, int y)
    {
        if (FindOwnUnit(Path.Combine(_modFolder, SourceRepositoryLayout.RootFor(plugin.Name)), plugin.Name, worldspace) is not { } worldspaceDocument)
            return null;
        var placement = CellPlacement.AtGrid(worldspace, x, y);
        var subBlock = Path.Combine(
            PathShape.DirectoryOf(worldspaceDocument),
            SourceRepositoryLayout.BlockLevelName(placement.BlockX, placement.BlockY), SourceRepositoryLayout.BlockLevelName(placement.SubX, placement.SubY));
        if (!Directory.Exists(subBlock)) return null;
        foreach (var document in Directory.EnumerateDirectories(subBlock).Select(cell => Path.Combine(cell, SourceRepositoryLayout.RecordDataFileName)))
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
            if (cell is JsonObject held && PlacedCell.Grid(held) == (x, y)) return DocumentText.FormKeyDeclaredIn(text, document, plugin.Name);
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

    internal SourceUnit Unit(string fullPath, string ownerFormKey, string? ownerRecordType, bool isEmbedded) =>
        new(fullPath, Path.GetRelativePath(_modFolder, fullPath), ownerFormKey, ownerRecordType, isEmbedded);

    // Matches the FormKey alone, never the EditorID, which a caller may hold stale mid-rename. Every
    // directory-per-record group is searched, since a cell's directory sits in its own group's blocks
    // or inside its worldspace's.
    internal string? FindOwnUnit(string sourceRoot, string pluginFileName, string formKey, bool byText = true) =>
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
    internal void Forget()
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

    internal SourceDocument? ContainerDocument(
        PluginAddress plugin, RecordIdentity identity, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (Locate(plugin, identity) is not { } unit || !File.Exists(unit.FullPath)) return null;
        var text = Encoding.UTF8.GetString(DocumentText.StripUtf8Bom(File.ReadAllBytes(unit.FullPath)));

        if (!unit.IsEmbedded)
            return new SourceDocument(identity.FormKey, identity.RecordType, identity.EditorId, text);

        if (IdentityOf(plugin, unit.OwnerFormKey, schemas) is not { } owner)
        {
            throw new UnreadableSourceDocumentException(
                $"{unit.RelativePath} carries {identity.FormKey}, but {unit.OwnerFormKey} names no document of its own.");
        }
        return new SourceDocument(owner.FormKey, owner.RecordType, owner.EditorId, text);
    }

    internal DocumentContainment? ContainerOf(
        PluginAddress plugin, RecordIdentity identity, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (Locate(plugin, identity) is not { IsEmbedded: true } unit) return null;
        var owner = ContainerDocument(plugin, identity, schemas)
            ?? throw new UnreadableSourceDocumentException($"{unit.RelativePath} could not be read.");

        using var parsed = JsonDocument.Parse(owner.Body);
        return new ContainerDocuments(_release, schemas).ContainmentOf(owner.RecordType, parsed.RootElement, identity.FormKey);
    }

    /// <summary>Every document one plugin's tree holds right now, each as the record at its root. An
    /// embedded child belongs to its owner's document; answers with the child's own text.</summary>
    internal IReadOnlyList<SourceDocument> ReadAll(PluginAddress plugin)
    {
        var root = SourceRepositoryLayout.RootIn(_modFolder, plugin.Name);
        if (!Directory.Exists(root)) return [];

        var documents = new List<SourceDocument>();
        foreach (var path in Directory.EnumerateFiles(root, $"*{SourceRepositoryLayout.JsonSuffix}", SearchOption.AllDirectories))
        {
            if (DocumentText.ReadOrNull(path) is not { } text) continue;
            if (DocumentAt(Path.GetRelativePath(_modFolder, path), text, plugin.Name) is { } document)
                documents.Add(document);
        }
        return documents;
    }

    // Null for a file that holds no record: group and block metadata, a document that declares no
    // FormKey, and one whose type neither its path nor its own text names.
    internal SourceDocument? DocumentAt(string relativePath, string text, string pluginFileName)
    {
        if (SourceRepositoryLayout.CarriesNoRecord(relativePath)) return null;

        if (DocumentText.FormKeyDeclaredIn(text, relativePath, pluginFileName)
            is not { } formKey)
            return null;

        var recordType = SourceRepositoryLayout.RecordTypeOf(relativePath, _release)
                         ?? DocumentText.RootStringIn(text, "MutagenObjectType");
        return recordType == null
            ? null
            : new SourceDocument(formKey, recordType, DocumentText.RootStringIn(text, "EditorID"), text);
    }

    internal PluginSourceFiles FilesOf(PluginAddress plugin)
    {
        if (!_filesByPlugin.TryGetValue(plugin.Name, out var files))
            _filesByPlugin[plugin.Name] = files = WorkingTreeFiles(plugin);
        return files;
    }

    private PluginSourceFiles WorkingTreeFiles(PluginAddress plugin)
    {
        var root = SourceRepositoryLayout.RootIn(_modFolder, plugin.Name);
        if (!Directory.Exists(root)) return new PluginSourceFiles([], null);

        var files = new List<TreeFile>();
        foreach (var path in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            var relativePath = Path.GetRelativePath(_modFolder, path);
            if (RawBytesOrNull(path) is not { } content)
                return new PluginSourceFiles([], relativePath);
            files.Add(new TreeFile(relativePath, content));
        }
        return new PluginSourceFiles(Ordered(files), null);
    }

    private static IReadOnlyList<TreeFile> Ordered(IEnumerable<TreeFile> files) =>
        [.. files.OrderBy(file => file.RelativePath, StringComparer.Ordinal)];

    // Never exclusive owners of the file: it may have been deleted, moved or locked since the listing.
    private static byte[]? RawBytesOrNull(string path)
    {
        try
        {
            return File.ReadAllBytes(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
