using System.Globalization;
using System.Text;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>A tracked plugin's tree read as the documents it already holds (ADR-0007):
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
        _root = SourceRepositoryLayout.RootIn(modFolder, pluginFileName);
        _headerRelativePath = SourceRepositoryLayout.HeaderDocumentFor(pluginFileName);
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
                    $"{Path.GetFileName(_headerRelativePath)}, so it describes no plugin.", path);

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

        var holders = new OneDocumentPerFormKey(_modFolder);
        foreach (var groupDirectory in Directory.EnumerateDirectories(_root))
        {
            var folder = Path.GetFileName(groupDirectory);
            var directoryPerRecord = RecordTypeDispatch.For(_release)
                .DirectoryPerRecordTypeIn(folder, nested: false);

            var documents = directoryPerRecord switch
            {
                null => FlatGroup(groupDirectory, holders),
                var type when _containers.IsCell(type) => InteriorCells(groupDirectory, holders),
                _ => Worldspaces(groupDirectory, holders),
            };
            foreach (var document in documents) yield return document;
        }
    }

    // A group with no directory-per-record type files its records flat, and a container that is not a
    // cell or a worldspace keeps its own directory directly under it.
    private IEnumerable<PluginDocument> FlatGroup(string groupDirectory, OneDocumentPerFormKey holders) =>
        Directory
            .EnumerateFiles(groupDirectory, $"*{SourceRepositoryLayout.JsonSuffix}", SearchOption.AllDirectories)
            .SelectMany(file => DocumentsAt(file, cell: null, holders));

    // A block level's directory is named by its number, as the whole-mod serializer writes it.
    private IEnumerable<PluginDocument> InteriorCells(string cellsDirectory, OneDocumentPerFormKey holders)
    {
        foreach (var blockDirectory in Directory.EnumerateDirectories(cellsDirectory))
        {
            var block = Number(Path.GetFileName(blockDirectory));
            foreach (var subBlockDirectory in Directory.EnumerateDirectories(blockDirectory))
            {
                var structure = CellStructure.Interior(block, Number(Path.GetFileName(subBlockDirectory)));
                foreach (var cellDirectory in Directory.EnumerateDirectories(subBlockDirectory))
                {
                    var cell = SourceRepositoryLayout.ContainerDocumentHeldBy(cellDirectory);
                    foreach (var document in DocumentsAt(cell, structure, holders)) yield return document;
                }
            }
        }
    }

    private IEnumerable<PluginDocument> Worldspaces(string worldspacesDirectory, OneDocumentPerFormKey holders)
    {
        foreach (var worldspaceDirectory in Directory.EnumerateDirectories(worldspacesDirectory))
        {
            var own = SourceRepositoryLayout.ContainerDocumentHeldBy(worldspaceDirectory);
            foreach (var document in DocumentsAt(own, cell: null, holders)) yield return document;

            var worldspaceFormKey = DocumentText.FormKeyDeclaredBy(own, _pluginFileName);
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
                        var cell = SourceRepositoryLayout.ContainerDocumentHeldBy(cellDirectory);
                        foreach (var document in DocumentsAt(cell, structure, holders)) yield return document;
                    }
                }
            }
        }
    }

    // The header is the one document with a file of its own that is not yielded here: it has its own
    // member, and the index writes its row through a door of its own.
    private IEnumerable<PluginDocument> DocumentsAt(string file, CellStructure? cell, OneDocumentPerFormKey holders)
    {
        if (SourceRepositoryLayout.CarriesNoRecord(file)) yield break;

        var relativePath = Path.GetRelativePath(_modFolder, file);
        if (relativePath.Equals(_headerRelativePath, StringComparison.Ordinal)) yield break;
        if (Read(file) is not { } text) yield break;

        // A record filed here that nothing can read would go missing from the read model. The caller
        // degrades to the binary and says so, which is visible; dropping it here would not be.
        try
        {
            using var document = JsonDocument.Parse(text);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
                throw Unreadable(file, "its root is not an object");
        }
        catch (JsonException ex)
        {
            throw Unreadable(file, $"it is no JSON document: {ex.Message.TrimEnd('.')}");
        }

        var declared = DocumentText.FormKeyDeclaredIn(text, relativePath, _pluginFileName);
        var recordType = SourceRepositoryLayout.RecordTypeOf(relativePath, _release)
            ?? _containers.RecordTypeNamed(DocumentText.RootStringIn(text, MutagenObjectTypeMember))
            ?? throw Unreadable(file, "neither its path nor its text names a record type", declared);
        var formKey = declared ?? throw Unreadable(file, "it declares no FormKey");

        holders.Claim(formKey, file);
        yield return new PluginDocument(recordType, formKey, text, null, cell, ContentsOf(recordType, text));
        foreach (var child in Embedded(recordType, formKey, text, file))
        {
            holders.Claim(child.FormKey, file);
            yield return child;
        }
    }

    // What a cell holds, read off its own document: the tree files a child record inside its cell
    // (ADR-0006).
    private IReadOnlyList<ChildRecord>? ContentsOf(string recordType, string text)
    {
        if (!_containers.IsCell(recordType)) return null;

        using var document = JsonDocument.Parse(text);
        return [.. _containers.ChildrenOf(recordType, document.RootElement)
            .Select(c => new ChildRecord(c.FormKey, c.SlotName, c.SlotIndex))];
    }

    private const string MutagenObjectTypeMember = "MutagenObjectType";

    /// <summary>The text of one document in hand and of every child it embeds, by FormKey. An untyped
    /// child is carried too: history may hold a state that does not build (ADR-0007).</summary>
    internal IEnumerable<(string FormKey, string Text)> Expand(string recordType, string formKey, string text)
    {
        yield return (formKey, text);
        var table = _containers.RecordTypeNamed(recordType) ?? recordType;
        foreach (var embedded in EmbeddedTexts(table, formKey, text, ownerFile: null))
            yield return (embedded.Child.FormKey, embedded.Text);
    }

    /// <summary>Throws, naming <paramref name="file"/>, when <paramref name="text"/> embeds a child
    /// no record type resolves, as the whole read does.</summary>
    internal void RefuseUntypedChildren(string recordType, string formKey, string text, string file)
    {
        foreach (var embedded in EmbeddedTexts(recordType, formKey, text, file)) TypeOf(embedded.Child, file);
    }

    private string TypeOf(ContainerDocuments.ChildDocument child, string ownerFile) =>
        child.RecordType ?? throw Unreadable(ownerFile, child.WhyUntyped, child.FormKey);

    private IEnumerable<PluginDocument> Embedded(
        string ownerRecordType, string ownerFormKey, string ownerText, string ownerFile)
    {
        foreach (var (child, text, directOwner) in EmbeddedTexts(ownerRecordType, ownerFormKey, ownerText, ownerFile))
        {
            var childType = TypeOf(child, ownerFile);
            // The one embedded cell: a worldspace's top cell, outside every exterior block grid.
            var cell = _containers.IsCell(childType)
                ? CellPlacement.TopCellOf(directOwner).Structure
                : (CellStructure?)null;
            yield return new PluginDocument(childType, child.FormKey, text, null, cell, ContentsOf(childType, text));
        }
    }

    // A container's own document is the system of record for every child it embeds, at every depth: a
    // worldspace embeds its top cell, which embeds its placed references. An untyped child has no
    // slots to read.
    private IEnumerable<(ContainerDocuments.ChildDocument Child, string Text, string DirectOwner)> EmbeddedTexts(
        string ownerRecordType, string ownerFormKey, string ownerText, string? ownerFile)
    {
        List<ContainerDocuments.ChildDocument> children;
        using (var document = JsonDocument.Parse(ownerText))
            children = [.. _containers.ChildrenOf(ownerRecordType, document.RootElement)];

        var containerType = _containers.ContainerTypeOf(ownerRecordType);
        var ownerBytes = Encoding.UTF8.GetBytes(ownerText);
        foreach (var child in children)
        {
            if (!ContainerChildFields.EmbeddedSlotsFor(_release.ToCategory()).Contains((containerType, child.SlotName))) continue;

            // The index holds the file's own bytes (ADR-0005), so a hand edit the codec would respell
            // reaches it as the file spells it.
            var noSpan = $"its '{child.SlotName}' names '{child.FormKey}', and a child an embedded slot " +
                "names has a span of its owner's text that nothing here carries";
            var text = EmbeddedChildSplice.TextOf(ownerBytes, containerType, child.FormKey, _release)
                ?? throw (ownerFile is null
                    ? new UnreadableSourceDocumentException(ownerFormKey, noSpan)
                    : Unreadable(ownerFile, noSpan, child.FormKey));
            yield return (child, text, ownerFormKey);
            if (child.RecordType is not { } childType) continue;
            foreach (var deeper in EmbeddedTexts(childType, child.FormKey, text, ownerFile)) yield return deeper;
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
            return Encoding.UTF8.GetString(DocumentText.StripUtf8Bom(File.ReadAllBytes(path)));
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

    private UnreadableSourceDocumentException Unreadable(string file, string because, string? formKey = null) =>
        new(new UnreadableFile(
            Path.GetRelativePath(_modFolder, file), UnreadableSourceDocumentException.Because(file, because), formKey));
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

    internal UnreadableSourceDocumentException(string filePath, string because) : base(Because(filePath, because))
    {
    }

    internal UnreadableSourceDocumentException(UnreadableFile file) : base(file.Message)
    {
        File = file;
    }

    /// <summary>The file that could not be read, when one is known.</summary>
    public UnreadableFile? File { get; }

    internal static string Because(string filePath, string because) =>
        $"'{filePath}' is filed as a record in this plugin's source tree, but {because}.";
}
