using System.Globalization;
using System.Text;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceRepo;

/// <summary>A tracked plugin's tree read as the documents it already holds (ADR-0003):
/// each file as it stands, plus the children a container's document embeds. Nothing is deserialized
/// into a mod.</summary>
internal sealed class SourceTreeDocuments : IPluginDocuments
{
    private readonly string _modFolder;
    private readonly string _pluginFileName;
    private readonly GameRelease _release;
    private readonly ContainerDocuments _containers;
    private readonly string _root;
    private readonly string _headerRelativePath;

    internal SourceTreeDocuments(
        string modFolder, string pluginFileName, GameRelease release,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        _modFolder = modFolder;
        _pluginFileName = pluginFileName;
        _release = release;
        _containers = new ContainerDocuments(release, schemas);
        _root = SourceRepository.RootIn(modFolder, pluginFileName);
        _headerRelativePath = Path.Combine(
            SourceRepository.RootFor(pluginFileName), SourceRepository.RecordDataFileName);
    }

    /// <summary>Throws when the tree holds no readable root document: serving the binary instead of
    /// a tree that describes no plugin would be a silent lie.</summary>
    public PluginDocument Header
    {
        get
        {
            var path = Path.Combine(_modFolder, _headerRelativePath);
            var text = Read(path)
                ?? throw new FileNotFoundException(
                    $"'{_pluginFileName}' is tracked but its source tree holds no root " +
                    $"{SourceRepository.RecordDataFileName}, so it describes no plugin.", path);

            using var _ = JsonDocument.Parse(text);
            return new PluginDocument(
                PluginHeader.RecordType, PluginHeader.FormKeyFor(ModKey.FromFileName(_pluginFileName)), text);
        }
    }

    /// <summary>Always empty: a tree is read file by file, so no enumeration spans a whole record
    /// type to fail partway.</summary>
    public IReadOnlyList<RecordTypeFailure> Failures => [];

    public IEnumerable<PluginDocument> Records => WalkGroups();

    public void Dispose()
    {
    }

    private IEnumerable<PluginDocument> WalkGroups()
    {
        if (!Directory.Exists(_root)) yield break;

        foreach (var groupDirectory in Directory.EnumerateDirectories(_root))
        {
            var folder = Path.GetFileName(groupDirectory);
            var directoryPerRecord = RecordTypeDispatch.For(_release)
                .DirectoryPerRecordTypeIn(folder, nested: false);

            var documents = directoryPerRecord switch
            {
                null => FlatGroup(groupDirectory),
                var type when _containers.IsCell(type) => InteriorCells(groupDirectory),
                _ => Worldspaces(groupDirectory),
            };
            foreach (var document in documents) yield return document;
        }
    }

    // A group with no directory-per-record type files its records flat, and a container that is not a
    // cell or a worldspace keeps its own directory directly under it.
    private IEnumerable<PluginDocument> FlatGroup(string groupDirectory) =>
        Directory
            .EnumerateFiles(groupDirectory, $"*{SourceRepository.JsonSuffix}", SearchOption.AllDirectories)
            .SelectMany(file => DocumentsAt(file, cell: null));

    // Interior placement carries no gameplay meaning, so the block levels a cell sits under are read
    // as depth alone — every interior cell's block and sub-block are null.
    private IEnumerable<PluginDocument> InteriorCells(string cellsDirectory) =>
        Directory.EnumerateDirectories(cellsDirectory)
            .SelectMany(Directory.EnumerateDirectories)
            .SelectMany(Directory.EnumerateDirectories)
            .SelectMany(cellDirectory => DocumentsAt(
                Path.Combine(cellDirectory, SourceRepository.RecordDataFileName),
                new CellStructure(null, null, null, null, null, IsInterior: true)));

    private IEnumerable<PluginDocument> Worldspaces(string worldspacesDirectory)
    {
        foreach (var worldspaceDirectory in Directory.EnumerateDirectories(worldspacesDirectory))
        {
            var own = Path.Combine(worldspaceDirectory, SourceRepository.RecordDataFileName);
            foreach (var document in DocumentsAt(own, cell: null)) yield return document;

            var worldspaceFormKey = SourceRepository.FormKeyDeclaredBy(own, _pluginFileName);
            foreach (var blockDirectory in Directory.EnumerateDirectories(worldspaceDirectory))
            {
                var (blockX, blockY) = Coordinates(Path.GetFileName(blockDirectory));
                foreach (var subBlockDirectory in Directory.EnumerateDirectories(blockDirectory))
                {
                    var (subX, subY) = Coordinates(Path.GetFileName(subBlockDirectory));
                    var structure = new CellStructure(
                        worldspaceFormKey, blockX, blockY, subX, subY, IsInterior: false);

                    foreach (var cellDirectory in Directory.EnumerateDirectories(subBlockDirectory))
                    {
                        var cell = Path.Combine(cellDirectory, SourceRepository.RecordDataFileName);
                        foreach (var document in DocumentsAt(cell, structure)) yield return document;
                    }
                }
            }
        }
    }

    // The header is the one document with a file of its own that is not yielded here: it has its own
    // member, and the index writes its row through a door of its own.
    private IEnumerable<PluginDocument> DocumentsAt(string file, CellStructure? cell)
    {
        if (SourceRepository.CarriesNoRecord(file)) yield break;

        var relativePath = Path.GetRelativePath(_modFolder, file);
        if (relativePath.Equals(_headerRelativePath, StringComparison.Ordinal)) yield break;
        if (Read(file) is not { } text) yield break;

        // A record filed here that nothing can read would go missing from the read model. The caller
        // degrades to the binary and says so, which is visible; dropping it here would not be.
        using (var document = JsonDocument.Parse(text))
        {
            if (document.RootElement.ValueKind != JsonValueKind.Object)
                throw new UnreadableSourceDocumentException(file, "its root is not an object");
        }

        var recordType = SourceRepository.RecordTypeOf(relativePath, _release)
            ?? _containers.RecordTypeNamed(SourceRepository.RootStringIn(text, MutagenObjectTypeMember))
            ?? throw new UnreadableSourceDocumentException(file, "neither its path nor its text names a record type");

        var formKey = SourceRepository.FormKeyDeclaredIn(text, relativePath, _pluginFileName)
            ?? throw new UnreadableSourceDocumentException(file, "it declares no FormKey");

        yield return new PluginDocument(recordType, formKey, text, null, cell, ContentsOf(recordType, text));
        foreach (var child in Embedded(recordType, formKey, text, file)) yield return child;
    }

    // ADR-0005: what a cell's two placement groups hold. Read off its own document, since the tree
    // files a placed record inside its cell rather than beside it.
    private IReadOnlyList<PlacedInCell>? ContentsOf(string recordType, string text)
    {
        if (!_containers.IsCell(recordType)) return null;

        var containerType = _containers.ContainerTypeOf(recordType);
        using var document = JsonDocument.Parse(text);
        return [.. _containers.ChildrenOf(recordType, document.RootElement)
            .Where(c => PlacementGroups.Contains((containerType, c.SlotName)))
            .Select(c => new PlacedInCell(c.FormKey, c.SlotName.ToLowerInvariant()))];
    }

    // The two slots the placement table covers, named here rather than reached for through Records:
    // the tree reader is upstream of the index, not a caller of it.
    private static readonly HashSet<(string ParentType, string Slot)> PlacementGroups =
        [("Cell", "Persistent"), ("Cell", "Temporary")];

    private const string MutagenObjectTypeMember = "MutagenObjectType";

    /// <summary>One document already in hand, plus every child it embeds — the committed side of a
    /// reconcile, which reads its text from git rather than the working tree.</summary>
    internal IEnumerable<PluginDocument> Expand(string recordType, string formKey, string text)
    {
        var table = _containers.RecordTypeNamed(recordType) ?? recordType;
        yield return new PluginDocument(table, formKey, text, null, null, ContentsOf(table, text));
        foreach (var child in Embedded(table, formKey, text, formKey)) yield return child;
    }

    // A container's own document is the system of record for every child it embeds, at every depth: a
    // worldspace embeds its top cell, which embeds its placed references.
    private IEnumerable<PluginDocument> Embedded(
        string ownerRecordType, string ownerFormKey, string ownerText, string ownerDocument)
    {
        List<ContainerDocuments.ChildDocument> children;
        using (var document = JsonDocument.Parse(ownerText))
            children = [.. _containers.ChildrenOf(ownerRecordType, document.RootElement)];

        var containerType = _containers.ContainerTypeOf(ownerRecordType);
        var ownerBytes = Encoding.UTF8.GetBytes(ownerText);
        foreach (var child in children)
        {
            if (!ContainerMembers.Derived.EmbeddedSlots.Contains((containerType, child.SlotName))) continue;

            // ADR-0003: the tree is the system of record for a record's content, so a hand edit the
            // codec would respell reaches the index as the file spells it.
            var text = EmbeddedChildSplice.TextOf(ownerBytes, containerType, child.FormKey, _release)
                ?? throw new UnreadableSourceDocumentException(
                    ownerDocument,
                    $"its '{child.SlotName}' names '{child.FormKey}', and a child an embedded slot " +
                    "names has a span of its owner's text that nothing here carries");
            // The one embedded cell: a worldspace's top cell, outside every exterior block grid.
            var cell = _containers.IsCell(child.RecordType)
                ? new CellStructure(ownerFormKey, null, null, null, null, IsInterior: false)
                : (CellStructure?)null;

            yield return new PluginDocument(
                child.RecordType, child.FormKey, text, null, cell, ContentsOf(child.RecordType, text));
            foreach (var deeper in Embedded(child.RecordType, child.FormKey, text, ownerDocument)) yield return deeper;
        }
    }

    // "<x>, <y>" is the whole-mod door's own name for a block level's directory; an interior level is
    // a single number and contributes no coordinates.
    private static (int? X, int? Y) Coordinates(string folderName)
    {
        var parts = folderName.Split(',');
        if (parts.Length != 2) return (null, null);
        return (Number(parts[0]), Number(parts[1]));
    }

    private static int? Number(string text) =>
        int.TryParse(text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) ? value : null;

    // Never exclusive owners of the file: it may vanish or lock between the listing and the read.
    private static string? Read(string path)
    {
        try
        {
            return Encoding.UTF8.GetString(SourceRepository.StripUtf8Bom(File.ReadAllBytes(path)));
        }
        catch (FileNotFoundException)
        {
            return null;
        }
        catch (DirectoryNotFoundException)
        {
            return null;
        }
    }
}

/// <summary>A file a plugin's source tree files as a record that this reader cannot turn into a
/// document. Never swallowed: the caller degrades to the binary and records the reason.</summary>
public sealed class UnreadableSourceDocumentException : InvalidOperationException
{
    public UnreadableSourceDocumentException() : base("A source document could not be read.")
    {
    }

    public UnreadableSourceDocumentException(string message) : base(message)
    {
    }

    public UnreadableSourceDocumentException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    internal UnreadableSourceDocumentException(string filePath, string because)
        : base($"'{filePath}' is filed as a record in this plugin's source tree, but {because}.")
    {
    }
}
