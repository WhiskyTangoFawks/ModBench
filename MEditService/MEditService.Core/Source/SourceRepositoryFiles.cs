using System.Text;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>A plugin's whole source tree, and the file the read stopped at. Files is empty when one
/// is named: half a tree compiles to a binary missing records.</summary>
public sealed record PluginSourceFiles(IReadOnlyList<PristineFile> Files, string? Unreadable);

/// <summary>A plugin's source as files rather than as documents, and the two questions asked of that
/// same tree. Each answers at the working tree or at a named ref, and a ref needs no
/// checkout.</summary>
public sealed partial class SourceRepository
{
    // One repository is one operation, so a tree is read once and a ref costs one git pass: the next
    // compile looks again (ADR-0009 — never a file timestamp).
    private readonly Dictionary<string, PluginSourceFiles> _filesByPluginAndRef = new(StringComparer.Ordinal);

    /// <summary>Every file one plugin's source tree holds, relative to the mod folder — the carrier
    /// Track hands in, handed back out. Null <paramref name="gitRef"/> asks the working tree; empty
    /// when there is no source there.</summary>
    public PluginSourceFiles FilesOf(PluginKey plugin, string? gitRef)
    {
        var key = $"{plugin.Name}\n{gitRef}";
        if (!_filesByPluginAndRef.TryGetValue(key, out var files))
            _filesByPluginAndRef[key] = files = Read(plugin, gitRef);
        return files;
    }

    /// <summary>Which of <paramref name="formKeys"/> more than one document claims. Asked of the
    /// files, not of the compiled mod: the reader's FormKey-keyed RecordCache collapses two documents
    /// in one group folder to the last read.</summary>
    public IReadOnlyList<string> CollidingFormKeys(
        PluginKey plugin, IEnumerable<FormKey> formKeys, string? gitRef)
    {
        var entriesByTail = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var name in EntryNamesIn(FilesOf(plugin, gitRef).Files, RootFor(plugin.Name)))
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

    /// <summary>The document holding <paramref name="identity"/>, relative to the mod folder — a
    /// diagnostic's path for the Problems panel. Null when nothing there holds it.</summary>
    public string? RelativePathOf(PluginKey plugin, RecordIdentity identity, string? gitRef)
    {
        if (gitRef == null) return Locate(plugin, identity)?.RelativePath;

        // The header declares a ModKey rather than the FormKey the index files it under, so no text in
        // the tree carries that key; its document is the tree root's own.
        if (identity.RecordType == PluginHeader.RecordType) return HeaderDocumentFor(plugin.Name);

        var candidates = FilesOf(plugin, gitRef).Files
            .Select(file => (file.RelativePath, Text: Text(file)))
            .Where(candidate => candidate.Text.Contains(identity.FormKey, StringComparison.Ordinal))
            .ToList();

        foreach (var (relativePath, text) in candidates)
        {
            if (DocumentAt(relativePath, text, plugin.Name) is { } document
                && document.FormKey.Equals(identity.FormKey, StringComparison.Ordinal))
            {
                return relativePath;
            }
        }

        // Nothing of its own, so another record's document carries it inline, and that document is
        // what a diagnostic can name.
        return candidates.FirstOrDefault(c => CarriesFormKey(c.Text, identity.FormKey)).RelativePath;
    }

    /// <summary>The plugin header's own document, relative to the mod folder: the whole-mod door's
    /// root <c>RecordData.json</c>.</summary>
    internal static string HeaderDocumentFor(string pluginFileName) =>
        Path.Combine(RootFor(pluginFileName), RecordDataFileName);

    private PluginSourceFiles Read(PluginKey plugin, string? gitRef) =>
        gitRef == null
            ? WorkingTreeFiles(plugin)
            : new PluginSourceFiles(Ordered(CommittedFiles(plugin, gitRef)), null);

    private PluginSourceFiles WorkingTreeFiles(PluginKey plugin)
    {
        var root = RootIn(_modFolder, plugin.Name);
        if (!Directory.Exists(root)) return new PluginSourceFiles([], null);

        var files = new List<PristineFile>();
        foreach (var path in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            var relativePath = Path.GetRelativePath(_modFolder, path);
            if (RawBytesOrNull(path) is not { } content)
                return new PluginSourceFiles([], relativePath);
            files.Add(new PristineFile(relativePath, content));
        }
        return new PluginSourceFiles(Ordered(files), null);
    }

    private static IReadOnlyList<PristineFile> Ordered(IEnumerable<PristineFile> files) =>
        [.. files.OrderBy(file => file.RelativePath, StringComparer.Ordinal)];

    private IEnumerable<PristineFile> CommittedFiles(PluginKey plugin, string gitRef) =>
        BlobsAtRef(plugin.Name, gitRef)
            .Select(blob => new PristineFile(blob.RelativePath, Encoding.UTF8.GetBytes(blob.Text)));

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

    private static string Text(PristineFile file) => Encoding.UTF8.GetString(StripUtf8Bom(file.Content));

    // One name per entry under the tree's own root: every file, and every directory once however many
    // files it holds. A directory counted twice would read as a collision.
    private static IEnumerable<string> EntryNamesIn(IReadOnlyList<PristineFile> files, string treeRoot)
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
