using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>A plugin's whole source tree, and the file the read stopped at, relative to the source folder.
/// Files is empty when one is named: half a tree compiles to a binary missing records.</summary>
public sealed record PluginSourceFiles(IReadOnlyList<TreeFile> Files, string? Unreadable);

public enum SourceDivergenceKind
{
    Unreadable,
    HeaderChanged,
    DocumentChanged,
    Unproduced,
}

/// <summary>A file where a plugin's source and what the whole-mod door writes differ, and the field that
/// differs where the file holds the door's document with another meaning.</summary>
public sealed record SourceDivergence(SourceDivergenceKind Kind, string Path, string? Field = null);

/// <summary>A record's file held at HeldPath, where the layout puts it at BelongsAt, both as the mod
/// folder spells them.</summary>
public sealed record MisplacedFile(string FormKey, string HeldPath, string BelongsAt);

/// <summary>Every file where a plugin's source and what the door writes part ways, changes before files the
/// door writes nowhere, and the files that differ only in where they sit, which compile.</summary>
public sealed record SourceComparison(IReadOnlyList<SourceDivergence> Divergences, IReadOnlyList<MisplacedFile> Misplaced);

/// <summary>A source file that carries a record, as the source folder spells it, with its text and the record type
/// its path or its text names, null when neither does.</summary>
public sealed record RecordFile(string Path, string Text, string? RecordType);

/// <summary>The questions asked of a plugin's source as files rather than as documents.</summary>
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

    internal static IReadOnlyList<RecordFile> RecordFilesOf(PluginSourceFiles source, GameRelease gameRelease)
    {
        var types = RecordTypes.For(gameRelease);
        var records = new List<RecordFile>();
        foreach (var file in source.Files.Where(file => !SourceRepositoryLayout.CarriesNoRecord(file.RelativePath)))
        {
            var text = Encoding.UTF8.GetString(DocumentText.StripUtf8Bom(file.Content));
            var recordType = SourceRepositoryLayout.RecordTypeOf(file.RelativePath, gameRelease)
                ?? types.RecordTypeNamed(DocumentTokens.RootStringIn(text, LoquiUnions.UnionTypeDiscriminator));
            records.Add(new RecordFile(file.RelativePath, text, recordType));
        }
        return records;
    }

    internal static SourceComparison Compare(
        string pluginFileName, PluginSourceFiles source, IReadOnlyList<TreeFile> serialized)
    {
        if (source.Unreadable is { } unreadable)
            return new SourceComparison([new SourceDivergence(SourceDivergenceKind.Unreadable, unreadable)], []);

        var regenerated = SourceRepositoryLayout.PristineFilesOf(pluginFileName, serialized);
        var held = source.Files.ToDictionary(file => file.RelativePath, file => file.Content, StringComparer.Ordinal);
        var header = SourceRepositoryLayout.HeaderDocumentFor(pluginFileName);

        var misplaced = MisplacedFiles(pluginFileName, regenerated, held);
        var belongingAt = misplaced.Select(file => file.BelongsAt).ToHashSet(StringComparer.Ordinal);
        var heldAt = misplaced.Select(file => file.HeldPath).ToHashSet(StringComparer.Ordinal);

        var divergences = new List<SourceDivergence>();
        foreach (var file in regenerated.Where(file => !belongingAt.Contains(file.RelativePath)))
        {
            var kind = file.RelativePath == header ? SourceDivergenceKind.HeaderChanged : SourceDivergenceKind.DocumentChanged;
            if (!held.TryGetValue(file.RelativePath, out var content)) divergences.Add(new SourceDivergence(kind, file.RelativePath));
            else if (DocumentMeaning.FirstDifference(DocumentText.StripUtf8Bom(content), file.Content) is { } field)
                divergences.Add(new SourceDivergence(kind, file.RelativePath, field));
        }

        var written = regenerated.Select(file => file.RelativePath).ToHashSet(StringComparer.Ordinal);
        divergences.AddRange(held.Keys
            .Where(relativePath => !written.Contains(relativePath) && !heldAt.Contains(relativePath))
            .Order(StringComparer.Ordinal)
            .Select(relativePath => new SourceDivergence(SourceDivergenceKind.Unproduced, relativePath)));
        return new SourceComparison(divergences, misplaced);
    }

    // A held file the codec writes nowhere and a file it writes where nothing is held, with the same
    // meaning, are one record at a leaf name the layout does not give it. Differing meaning stays a divergence.
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

            var at = unheld.FindIndex(file => DocumentMeaning.FirstDifference(DocumentText.StripUtf8Bom(content), file.Content) is null);
            if (at < 0) continue;

            misplaced.Add(new MisplacedFile(formKey, heldPath, unheld[at].RelativePath));
            unheld.RemoveAt(at);
        }
        return misplaced;
    }

    private static string? FormKeyOf(string relativePath, byte[] content, string pluginFileName) =>
        DocumentText.FormKeyDeclaredIn(
            Encoding.UTF8.GetString(DocumentText.StripUtf8Bom(content)), relativePath, pluginFileName);

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
