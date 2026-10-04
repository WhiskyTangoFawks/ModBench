using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>A plugin's whole source tree, and the file the read stopped at. Files is empty when one
/// is named: half a tree compiles to a binary missing records.</summary>
public sealed record PluginSourceFiles(IReadOnlyList<TreeFile> Files, string? Unreadable);

public enum SourceDivergenceKind
{
    Unreadable,
    HeaderChanged,
    DocumentChanged,
    Unproduced,
}

/// <summary>The first file where a plugin's source and what the whole-mod door writes for it differ,
/// as the mod folder spells it.</summary>
public sealed record SourceDivergence(SourceDivergenceKind Kind, string Path);

/// <summary>A plugin's source as files rather than as documents, and the two questions asked of that
/// same tree, at the working tree.</summary>
public sealed partial class SourceRepository
{
    // One repository is one operation, so a tree is read once: the next compile looks again, never
    // trusting a file timestamp (ADR-0003).
    private readonly Dictionary<string, PluginSourceFiles> _filesByPlugin = new(StringComparer.Ordinal);

    /// <summary>Every file one plugin's source tree holds in the working tree, relative to the mod
    /// folder — the carrier Track hands in, handed back out. Empty when there is no source there.</summary>
    public PluginSourceFiles FilesOf(PluginAddress plugin)
    {
        if (!_filesByPlugin.TryGetValue(plugin.Name, out var files))
            _filesByPlugin[plugin.Name] = files = WorkingTreeFiles(plugin);
        return files;
    }

    /// <summary>Which of <paramref name="formKeys"/> more than one document claims. Asked of the
    /// files, not of the compiled mod: the reader's FormKey-keyed RecordCache collapses two documents
    /// in one group folder to the last read.</summary>
    public IReadOnlyList<string> CollidingFormKeys(PluginAddress plugin, IEnumerable<FormKey> formKeys)
    {
        var entriesByTail = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var name in EntryNamesIn(FilesOf(plugin).Files, RootFor(plugin.Name)))
        {
            foreach (var tail in TailsCarriedBy(name))
                entriesByTail[tail] = entriesByTail.GetValueOrDefault(tail) + 1;
        }

        var colliding = new List<string>();
        foreach (var formKey in formKeys)
        {
            var filesafe = LeafNameFor(formKey, editorId: null, isDirectory: true);
            var units = entriesByTail.GetValueOrDefault(filesafe)
                        + entriesByTail.GetValueOrDefault(filesafe + JsonSuffix);
            if (units > 1) colliding.Add(formKey.ToString());
        }
        return colliding;
    }

    /// <summary>Where the source and <paramref name="serialized"/>, the door's tree for the mod it
    /// compiles to, first part ways; null when they match. A file that cannot be read outranks every
    /// other answer, and content the door does not write was dropped by the parse.</summary>
    public SourceDivergence? DivergenceFrom(PluginAddress plugin, IReadOnlyList<TreeFile> serialized)
    {
        var source = FilesOf(plugin);
        if (source.Unreadable is { } unreadable)
            return new SourceDivergence(SourceDivergenceKind.Unreadable, unreadable);

        var regenerated = PristineFilesOf(plugin.Name, serialized);
        var held = source.Files.ToDictionary(file => file.RelativePath, file => file.Content, StringComparer.Ordinal);
        var header = HeaderDocumentFor(plugin.Name);

        foreach (var file in regenerated)
        {
            if (held.TryGetValue(file.RelativePath, out var content) && content.AsSpan().SequenceEqual(file.Content))
                continue;

            return new SourceDivergence(
                file.RelativePath == header ? SourceDivergenceKind.HeaderChanged : SourceDivergenceKind.DocumentChanged,
                file.RelativePath);
        }

        var written = regenerated.Select(file => file.RelativePath).ToHashSet(StringComparer.Ordinal);
        var unproduced = held.Keys
            .Where(relativePath => !written.Contains(relativePath))
            .Order(StringComparer.Ordinal)
            .FirstOrDefault();
        return unproduced is null ? null : new SourceDivergence(SourceDivergenceKind.Unproduced, unproduced);
    }

    /// <summary>The document holding <paramref name="identity"/>, relative to the mod folder — a
    /// diagnostic's path for the Problems panel. Null when nothing there holds it.</summary>
    public string? RelativePathOf(PluginAddress plugin, RecordIdentity identity) =>
        Locate(plugin, identity)?.RelativePath;

    /// <summary>The plugin header's own document, relative to the mod folder: the whole-mod door's
    /// root <c>RecordData.json</c>.</summary>
    public static string HeaderDocumentFor(string pluginFileName) =>
        Path.Combine(RootFor(pluginFileName), RecordDataFileName);

    private PluginSourceFiles WorkingTreeFiles(PluginAddress plugin)
    {
        var root = RootIn(_modFolder, plugin.Name);
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

    // One name per entry under the tree's own root: every file, and every directory once however many
    // files it holds. A directory counted twice would read as a collision.
    private static IEnumerable<string> EntryNamesIn(IReadOnlyList<TreeFile> files, string treeRoot)
    {
        var directories = new HashSet<string>(StringComparer.Ordinal);
        foreach (var relativePath in files.Select(file => file.RelativePath))
        {
            yield return Path.GetFileName(relativePath);

            var directory = Path.GetDirectoryName(relativePath);
            while (!string.IsNullOrEmpty(directory)
                   && !directory.Equals(treeRoot, StringComparison.Ordinal)
                   && directories.Add(directory))
            {
                yield return Path.GetFileName(directory);
                directory = Path.GetDirectoryName(directory);
            }
        }
    }

    // More than one candidate arises only when an EditorID itself contains " - "; a non-FormKey
    // candidate is simply never looked up.
    private static IEnumerable<string> TailsCarriedBy(string leaf)
    {
        yield return leaf;

        const string separator = " - ";
        var at = leaf.IndexOf(separator, StringComparison.Ordinal);
        while (at >= 0)
        {
            yield return leaf[(at + separator.Length)..];
            at = leaf.IndexOf(separator, at + separator.Length, StringComparison.Ordinal);
        }
    }
}
