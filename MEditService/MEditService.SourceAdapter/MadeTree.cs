using System.IO.Enumeration;
using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

/// <summary>A record of a tree made from records: its text, and the slot of the container holding it, or the worldspace an
/// exterior cell sits in; neither for a record its group holds.</summary>
public sealed record MadeRecord(RecordIdentity Identity, string Text, DocumentContainment? Container = null, string? Worldspace = null);

/// <summary>Records laid out in memory as a source folder holds them: each embedded child in its container's document, each
/// other record where the layout places a new one, with the levels above it.</summary>
internal sealed class MadeTree : ISourceFiles
{
    // Nothing is read or written here: the layout composes absolute paths, and the files leave relative to it.
    private static readonly string Nowhere = Path.Combine(Path.GetTempPath(), "medit-made-tree");

    private readonly Dictionary<string, string> _files = new(StringComparer.Ordinal);
    private readonly HashSet<string> _directories = new(StringComparer.Ordinal);

    /// <summary>The files, relative to the source folder, of <paramref name="records"/> laid out as
    /// <paramref name="pluginFileName"/>'s tree. Every container and worldspace a record names is among them.</summary>
    internal static IReadOnlyList<TreeFile> FilesOf(string pluginFileName, IReadOnlyList<MadeRecord> records, GameRelease release)
    {
        var tree = new MadeTree();
        var locator = new SourceRepositoryLocator(Nowhere, release, tree);
        var layout = new SourceRepositoryLayout(Nowhere, release, locator, tree);
        var plugin = new PluginAddress(pluginFileName, string.Empty);
        var types = RecordTypes.For(release);

        var byKey = records.ToDictionary(record => record.Identity.FormKey, StringComparer.Ordinal);
        int DepthOf(MadeRecord record)
        {
            var depth = 0;
            for (var parent = ParentOf(record); parent is not null; parent = ParentOf(Held(byKey, parent))) depth++;
            return depth;
        }

        var texts = byKey.ToDictionary(held => held.Key, held => held.Value.Text, StringComparer.Ordinal);
        bool Embedded(MadeRecord record) => record.Container is { } held && types.IsEmbeddedSlot(held.ParentRecordType, held.SlotName);
        foreach (var child in records.Where(Embedded).OrderByDescending(DepthOf))
        {
            var held = child.Container ?? throw new InvalidOperationException("Expected an embedded child to name its container.");
            texts[held.ParentFormKey] = Appended(texts[held.ParentFormKey], held, child, texts[child.Identity.FormKey], release);
        }

        var placed = new Dictionary<string, string>(StringComparer.Ordinal);
        var placing = 0;
        foreach (var record in records.Where(record => !Embedded(record)).OrderBy(DepthOf))
        {
            // A worldspace's directory is found by the locator, which lists the tree once a level has been placed.
            if (DepthOf(record) != placing)
            {
                placing = DepthOf(record);
                locator.Forget();
            }
            var text = texts[record.Identity.FormKey];
            var at = record.Container is { } held
                ? SourceRepositoryLayout.ChildDocumentIn(PathShape.DirectoryOf(placed[held.ParentFormKey]), held.SlotName, record.Identity, release)
                : tree.Placed(layout, plugin, record, text);
            tree.Write(at, text);
            placed[record.Identity.FormKey] = at;
        }

        return [.. tree._files.Select(file => new TreeFile(Path.GetRelativePath(Nowhere, file.Key), Encoding.UTF8.GetBytes(file.Value)))];
    }

    private static string? ParentOf(MadeRecord record) => record.Container?.ParentFormKey ?? record.Worldspace;

    private static MadeRecord Held(Dictionary<string, MadeRecord> byKey, string formKey) =>
        byKey.TryGetValue(formKey, out var held)
            ? held
            : throw new InvalidOperationException($"Expected the records to hold {formKey}, which holds another of them.");

    private static string Appended(string containerText, DocumentContainment held, MadeRecord child, string childText, GameRelease release)
    {
        ChildAppend appended;
        try
        {
            appended = ContainerDocumentEdits.WithChildAppended(containerText, release, held.ParentRecordType, held.SlotName, childText, child.Identity.RecordType);
        }
        catch (Exception ex) when (OutOfMemoryOrCancellation.In(ex) is null)
        {
            throw SourceStopException.Unreadable($"{child.Identity.FormKey} or {held.ParentFormKey}, which holds it, is no record: {ex.Message}");
        }

        return appended switch
        {
            ChildAppend.Appended(var withChild) => withChild,
            ChildAppend.SlotHeld(var other) => throw SourceStopException.Of(new SourceFailure.SlotHeld(
                $"{held.ParentFormKey}'s {held.SlotName} already holds {other}, so {child.Identity.FormKey} cannot take its place.")),
            _ => throw new InvalidOperationException($"Expected the codec to append the child or answer its slot held, not {appended}."),
        };
    }

    private string Placed(SourceRepositoryLayout layout, PluginAddress plugin, MadeRecord record, string text)
    {
        var placement = record.Worldspace is { } worldspace
            ? SourceRepositoryWrites.PlacementIn(worldspace, new SourceDocument(record.Identity.FormKey, record.Identity.RecordType, record.Identity.EditorId, text))
            : (CellPlacement?)null;
        var (levels, unit) = layout.PlaceNewDocument(plugin, record.Identity, placement)
            ?? throw new InvalidOperationException($"Expected {record.Identity.FormKey}, a {record.Identity.RecordType}, to name the container holding it.");
        foreach (var level in levels) Write(Path.Combine(Nowhere, level.Path), level.Text);
        return unit.FullPath;
    }

    private void Write(string path, string text)
    {
        var full = Path.GetFullPath(path);
        _files[full] = text;
        for (var directory = Path.GetDirectoryName(full); directory is not null && directory.Length > Nowhere.Length; directory = Path.GetDirectoryName(directory))
            _directories.Add(directory);
    }

    public bool FileExists(string path) => _files.ContainsKey(Path.GetFullPath(path));

    public bool DirectoryExists(string path) => _directories.Contains(Path.GetFullPath(path));

    public byte[] ReadAllBytes(string path) => Encoding.UTF8.GetBytes(ReadAllText(path));

    public string ReadAllText(string path) =>
        _files.TryGetValue(Path.GetFullPath(path), out var text) ? text : throw new FileNotFoundException($"Could not find file '{path}'.", path);

    public bool HoldsUnsavedText(string path) => false;

    public IEnumerable<string> EntriesUnder(string directory) =>
        _files.Keys.Concat(_directories).Where(entry => SourceRepositoryLocator.IsUnder(Path.GetFullPath(directory), entry));

    public IEnumerable<string> FilesIn(string directory, string pattern, SearchOption option)
    {
        var full = Path.GetFullPath(directory);
        return _files.Keys.Where(file =>
            (option == SearchOption.AllDirectories ? SourceRepositoryLocator.IsUnder(full, file) : Path.GetDirectoryName(file) == full)
            && FileSystemName.MatchesSimpleExpression(pattern, Path.GetFileName(file)));
    }

    public IEnumerable<string> DirectoriesIn(string directory)
    {
        var full = Path.GetFullPath(directory);
        return _directories.Where(held => Path.GetDirectoryName(held) == full);
    }
}
