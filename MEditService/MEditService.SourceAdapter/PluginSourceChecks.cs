using MEditService.Codec.Serialization;
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

/// <summary>The two questions asked of a plugin's source as files rather than as documents.</summary>
internal static class PluginSourceChecks
{
    internal static IReadOnlyList<string> CollidingFormKeys(
        string pluginFileName, PluginSourceFiles source, IEnumerable<FormKey> formKeys)
    {
        var entriesByTail = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var name in EntryNamesIn(source.Files, SourceRepositoryLayout.RootFor(pluginFileName)))
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

    internal static SourceDivergence? DivergenceFrom(
        string pluginFileName, PluginSourceFiles source, IReadOnlyList<TreeFile> serialized)
    {
        if (source.Unreadable is { } unreadable)
            return new SourceDivergence(SourceDivergenceKind.Unreadable, unreadable);

        var regenerated = SourceRepositoryLayout.PristineFilesOf(pluginFileName, serialized);
        var held = source.Files.ToDictionary(file => file.RelativePath, file => file.Content, StringComparer.Ordinal);
        var header = SourceRepositoryLayout.HeaderDocumentFor(pluginFileName);

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
