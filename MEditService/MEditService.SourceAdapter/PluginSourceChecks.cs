using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
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

/// <summary>A record's file held at HeldPath, where the layout puts it at BelongsAt, both as the mod
/// folder spells them.</summary>
public sealed record MisplacedFile(string FormKey, string HeldPath, string BelongsAt);

/// <summary>Where a plugin's source and what the door writes for it part ways, and the files that
/// differ from it only in where they sit. A misplaced file is no divergence: it compiles.</summary>
public sealed record SourceComparison(SourceDivergence? Divergence, IReadOnlyList<MisplacedFile> Misplaced);

/// <summary>The two questions asked of a plugin's source as files rather than as documents.</summary>
internal static class PluginSourceChecks
{
    internal static IReadOnlyList<string> CollidingFormKeys(
        string pluginFileName, PluginSourceFiles source, IEnumerable<FormKey> formKeys, GameRelease gameRelease)
    {
        var entriesByTail = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var name in EntryNamesIn(source.Files, SourceRepositoryLayout.RootFor(pluginFileName), gameRelease))
        {
            foreach (var tail in TailsCarriedBy(name))
                entriesByTail[tail] = entriesByTail.GetValueOrDefault(tail) + 1;
        }

        var colliding = new List<string>();
        foreach (var formKey in formKeys)
        {
            var filesafe = SourceRepositoryLayout.LeafNameFor(formKey, editorId: null, isDirectory: true);
            var units = entriesByTail.GetValueOrDefault(filesafe)
                        + entriesByTail.GetValueOrDefault(filesafe + SourceRepositoryLayout.JsonSuffix);
            if (units > 1) colliding.Add(formKey.ToString());
        }
        return colliding;
    }

    internal static SourceComparison Compare(
        string pluginFileName, PluginSourceFiles source, IReadOnlyList<TreeFile> serialized)
    {
        if (source.Unreadable is { } unreadable)
            return new SourceComparison(new SourceDivergence(SourceDivergenceKind.Unreadable, unreadable), []);

        var regenerated = SourceRepositoryLayout.PristineFilesOf(pluginFileName, serialized);
        var held = source.Files.ToDictionary(file => file.RelativePath, file => file.Content, StringComparer.Ordinal);
        var header = SourceRepositoryLayout.HeaderDocumentFor(pluginFileName);

        var misplaced = MisplacedFiles(pluginFileName, regenerated, held);
        var belongingAt = misplaced.Select(file => file.BelongsAt).ToHashSet(StringComparer.Ordinal);
        var heldAt = misplaced.Select(file => file.HeldPath).ToHashSet(StringComparer.Ordinal);

        foreach (var file in regenerated.Where(file => !belongingAt.Contains(file.RelativePath)))
        {
            if (held.TryGetValue(file.RelativePath, out var content) && content.AsSpan().SequenceEqual(file.Content))
                continue;

            return new SourceComparison(
                new SourceDivergence(
                    file.RelativePath == header ? SourceDivergenceKind.HeaderChanged : SourceDivergenceKind.DocumentChanged,
                    file.RelativePath),
                misplaced);
        }

        var written = regenerated.Select(file => file.RelativePath).ToHashSet(StringComparer.Ordinal);
        var unproduced = held.Keys
            .Where(relativePath => !written.Contains(relativePath) && !heldAt.Contains(relativePath))
            .Order(StringComparer.Ordinal)
            .FirstOrDefault();
        return new SourceComparison(
            unproduced is null ? null : new SourceDivergence(SourceDivergenceKind.Unproduced, unproduced), misplaced);
    }

    // A held file the codec writes nowhere and a file it writes where nothing is held, with the same
    // bytes, are one record at a leaf name the layout does not give it. Differing bytes stay a divergence.
    private static List<MisplacedFile> MisplacedFiles(
        string pluginFileName, IReadOnlyList<TreeFile> regenerated, Dictionary<string, byte[]> held)
    {
        var unheld = regenerated.Where(file => !held.ContainsKey(file.RelativePath)).ToList();
        var misplaced = new List<MisplacedFile>();
        if (unheld.Count == 0) return misplaced;

        var regeneratedPaths = regenerated.Select(file => file.RelativePath).ToHashSet(StringComparer.Ordinal);
        foreach (var (heldPath, content) in held.Where(file => !regeneratedPaths.Contains(file.Key)).OrderBy(file => file.Key, StringComparer.Ordinal))
        {
            if (FormKeyOf(heldPath, content, pluginFileName) is not { } formKey) continue;

            var at = unheld.FindIndex(file => file.Content.AsSpan().SequenceEqual(content));
            if (at < 0) continue;

            misplaced.Add(new MisplacedFile(formKey, heldPath, unheld[at].RelativePath));
            unheld.RemoveAt(at);
        }
        return misplaced;
    }

    private static string? FormKeyOf(string relativePath, byte[] content, string pluginFileName) =>
        DocumentText.FormKeyDeclaredIn(
            System.Text.Encoding.UTF8.GetString(DocumentText.StripUtf8Bom(content)), relativePath, pluginFileName);

    // One name per entry under the tree's own root: every file, and every directory once however many
    // files it holds, and a container's document is its directory's. A directory counted twice would read
    // as a collision.
    private static IEnumerable<string> EntryNamesIn(IReadOnlyList<TreeFile> files, string treeRoot, GameRelease gameRelease)
    {
        var directories = new HashSet<string>(StringComparer.Ordinal);
        var paths = files.Select(file => file.RelativePath).ToList();
        var documents = SourceRepositoryLayout.ContainerDocumentsAmong(paths, gameRelease);
        foreach (var relativePath in paths)
        {
            var directory = Path.GetDirectoryName(relativePath);
            if (!documents.Contains(relativePath)) yield return Path.GetFileName(relativePath);

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
