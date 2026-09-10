using System.Globalization;
using System.Text;
using System.Text.Json;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>A tracked plugin's tree read as the documents it already holds (ADR-0041 amendment):
/// each file as it stands, plus the children a container's document embeds. Nothing is deserialized
/// into a mod.</summary>
internal sealed class SourceTreeDocuments : IPluginDocuments
{
    private readonly string _modFolder;
    private readonly string _pluginFileName;
    private readonly GameRelease _release;
    private readonly ContainerDocuments _containers;
    private readonly RecordTextCodec _codec = new(NullLogger<RecordTextCodec>.Instance);
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

    /// <summary>Throws when the tree holds no root document: a plugin tree without one describes no
    /// plugin, and serving the binary instead would be a silent lie.</summary>
    public PluginDocument Header => new(
        PluginHeader.RecordType,
        PluginHeader.FormKeyFor(ModKey.FromFileName(_pluginFileName)),
        Read(Path.Combine(_modFolder, _headerRelativePath))
            ?? throw new FileNotFoundException(
                $"'{_pluginFileName}' is tracked but its source tree holds no root " +
                $"{SourceRepository.RecordDataFileName}, so it describes no plugin.",
                Path.Combine(_modFolder, _headerRelativePath)));

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
    // as depth alone (PlacementWalker records null block/sub for every interior cell).
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

            var worldspaceFormKey = SourceRepository.FormKeyDeclaredBy(own, _modFolder, _pluginFileName);
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

        var recordType = SourceRepository.RecordTypeOf(relativePath, _release)
            ?? _containers.RecordTypeNamed(SourceRepository.RootStringIn(text, MutagenObjectTypeMember));
        if (recordType == null) yield break;

        if (SourceRepository.FormKeyDeclaredIn(text, relativePath, _headerRelativePath, _pluginFileName)
            is not { } formKey)
        {
            yield break;
        }

        yield return new PluginDocument(recordType, formKey, text, null, cell);
        foreach (var child in Embedded(recordType, formKey, text)) yield return child;
    }

    private const string MutagenObjectTypeMember = "MutagenObjectType";

    /// <summary>One document already in hand, plus every child it embeds — the committed side of a
    /// reconcile, which reads its text from git rather than the working tree.</summary>
    internal IEnumerable<PluginDocument> Expand(string recordType, string formKey, string text)
    {
        var table = _containers.RecordTypeNamed(recordType) ?? recordType;
        yield return new PluginDocument(table, formKey, text);
        foreach (var child in Embedded(table, formKey, text)) yield return child;
    }

    // A container's own document is the system of record for every child it embeds, at every depth: a
    // worldspace embeds its top cell, which embeds its placed references.
    private IEnumerable<PluginDocument> Embedded(string ownerRecordType, string ownerFormKey, string ownerText)
    {
        List<ContainerDocuments.ChildDocument> children;
        using (var document = JsonDocument.Parse(ownerText))
            children = [.. _containers.ChildrenOf(ownerRecordType, document.RootElement)];

        var containerType = _containers.ContainerTypeOf(ownerRecordType);
        foreach (var child in children)
        {
            if (!ContainerMembers.Derived.EmbeddedSlots.Contains((containerType, child.SlotName))) continue;

            var text = _containers.TextOf(_codec, child);
            // The one embedded cell: a worldspace's top cell, outside every exterior block grid.
            var cell = _containers.IsCell(child.RecordType)
                ? new CellStructure(ownerFormKey, null, null, null, null, IsInterior: false)
                : (CellStructure?)null;

            yield return new PluginDocument(child.RecordType, child.FormKey, text, null, cell);
            foreach (var deeper in Embedded(child.RecordType, child.FormKey, text)) yield return deeper;
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
