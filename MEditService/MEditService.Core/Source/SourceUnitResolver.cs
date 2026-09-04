using MEditService.Core.Records;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>The file holding a record. For a container or embedded child it was found on disk, since
/// none is computable; for a flat record it is the computed path, which may not exist.</summary>
internal readonly record struct SourceUnit(
    string FullPath, string RelativePath, string OwnerFormKey, string OwnerRecordType, bool IsEmbedded)
{
    /// <summary>A container's own field file, not a flat file. The header's root RecordData.json shares
    /// the filename, so <see cref="OwnerRecordType"/> distinguishes them, or a header delete would
    /// remove the whole source root.</summary>
    internal bool IsDirectoryPerRecord =>
        OwnerRecordType != HeaderIndexer.RecordType
        && Path.GetFileName(FullPath).Equals(SourceUnitResolver.RecordDataFileName, StringComparison.Ordinal);
}

/// <summary>The record→source-unit question for every record shape (ADR-0041 amendment). Disk, not a
/// path map: the tree is the serializer's own output and cannot drift from it. Scans are narrowed
/// to one group subtree.</summary>
internal static class SourceUnitResolver
{
    /// <summary>The whole-mod door's own name for a directory-per-record container's field file
    /// (<c>SerializationHelper.RecordDataFileNameWithoutExtension</c> plus the JSON kernel's
    /// extension).</summary>
    internal const string RecordDataFileName = "RecordData.json";

    /// <summary>The whole-mod door's own name for a group or block level's metadata file. Also the
    /// carrier for those levels' ordered child lists (<see cref="SourceChildOrder"/>), hence shared.</summary>
    internal const string GroupRecordDataFileName = "GroupRecordData.json";

    private const string JsonSuffix = ".json";

    /// <summary><paramref name="formKey"/>'s source unit, or null when nothing holds it and the index
    /// knows no container that would. The scan matches on FormKey alone, so a stale
    /// <paramref name="editorId"/> cannot mislead it.</summary>
    internal static SourceUnit? Resolve(
        IRecordReads reads, PluginKey plugin, string modFolder,
        string formKey, string recordType, string? editorId, GameRelease release,
        SourceUnitResolutionCache? cache = null)
    {
        // The header's unit is the fixed root RecordData.json (#661): nothing to compute, scan or embed.
        if (recordType == HeaderIndexer.RecordType)
        {
            var headerPath = Path.Combine(modFolder, SourceRecordPath.RootFor(plugin.Name), RecordDataFileName);
            return new SourceUnit(
                headerPath, Path.GetRelativePath(modFolder, headerPath), formKey, recordType, IsEmbedded: false);
        }

        // A flat record: the path is computed, then corrected if the file has been renamed out from
        // under it. The overwhelmingly common edit pays one File.Exists and searches nothing.
        try
        {
            var flat = FlatSourcePath(modFolder, plugin.Name, recordType, formKey, editorId, release);
            return new SourceUnit(
                flat, Path.GetRelativePath(modFolder, flat), formKey, recordType, IsEmbedded: false);
        }
        catch (NotSupportedException)
        {
            // Not flat — a container, or a child with no top-level group of its own. Fall through.
        }

        // A placed reference is embedded in its cell by definition and the index knows the cell outright —
        // no scan for the most common container-shaped edit.
        if (reads.GetPlacement(formKey, plugin) is { } placement)
            return ResolveOwner(reads, plugin, modFolder, placement.ParentCell, release, cache);

        // Everything else may still have a file of its own — a Cell, a Worldspace, a Quest, a dialog
        // topic, a scene. Look for it before assuming it is embedded.
        var root = Path.Combine(modFolder, SourceRecordPath.RootFor(plugin.Name));
        if (FindOwnUnit(reads, plugin, root, formKey, recordType, release, cache) is { } own)
        {
            return new SourceUnit(
                own, Path.GetRelativePath(modFolder, own), formKey, recordType, IsEmbedded: false);
        }

        // No file of its own, so it is embedded in a parent's document. Landscape and NavigationMeshes
        // arrive through container_child; a Worldspace's TopCell has no directory and arrives through
        // cell_location's own parent link.
        var parent = reads.GetContainerParent(plugin, formKey)?.ParentFormKey
                     ?? reads.GetCellLocation(plugin, formKey)?.ParentWorldspace;

        return parent == null ? null : ResolveOwner(reads, plugin, modFolder, parent, release, cache);
    }

    /// <summary>The computed path when it exists, else whichever file in the group folder carries this
    /// FormKey. Name and document EditorIDs can disagree, and trusting the name alone would read a live
    /// record as deleted.</summary>
    internal static string FlatSourcePath(
        string modFolder, string pluginFileName, string recordType, string formKey, string? editorId,
        GameRelease release)
    {
        var computed = Path.Combine(
            modFolder, SourceRecordPath.For(pluginFileName, recordType, formKey, editorId, release));
        if (File.Exists(computed)) return computed;

        var groupFolder = RecordTypeDispatch.For(release).FolderNameFor(recordType);
        if (groupFolder == null) return computed;

        var groupDirectory = Path.Combine(modFolder, SourceRecordPath.RootFor(pluginFileName), groupFolder);
        if (!Directory.Exists(groupDirectory)) return computed;

        var suffix = FilesafeFormKey(formKey) + JsonSuffix;
        var matches = Directory
            .EnumerateFiles(groupDirectory, $"*{suffix}", SearchOption.TopDirectoryOnly)
            .Where(f => NameCarries(Path.GetFileName(f), suffix))
            .Take(2)
            .ToList();

        return matches.Count switch
        {
            0 => computed,
            1 => matches[0],
            _ => throw new AmbiguousSourceUnitException(
                $"More than one file in '{groupDirectory}' claims FormKey {formKey}. A FormKey is unique " +
                "within a mod, so this tree is corrupt — most likely a rename that was interrupted " +
                "partway. Resolve the duplicate by hand before editing."),
        };
    }

    // Re-entered through Resolve so a nested container needs no special case; bounded because the index
    // cannot claim a record contains itself.
    private static SourceUnit? ResolveOwner(
        IRecordReads reads, PluginKey plugin, string modFolder, string ownerFormKey, GameRelease release,
        SourceUnitResolutionCache? cache)
    {
        // One cell's worth of placed refs shares one owner read and one scan.
        if (cache != null && cache.Owners.TryGetValue(ownerFormKey, out var memoized)) return memoized;

        SourceUnit? resolved = null;
        if (reads.GetDocument(ownerFormKey, plugin) is { } owner
            && Resolve(reads, plugin, modFolder, ownerFormKey, owner.RecordType, owner.EditorId, release, cache) is { } unit)
        {
            resolved = unit with { IsEmbedded = true };
        }
        if (cache != null) cache.Owners[ownerFormKey] = resolved;
        return resolved;
    }

    /// <summary>Which FormKeys more than one source unit claims. Asked of the tree, not the compiled mod:
    /// the reader's FormKey-keyed RecordCache silently collapses two files in one group folder to the
    /// last read.</summary>
    internal static IReadOnlyList<string> FormKeysWithMoreThanOneSourceUnit(
        string sourceRoot, IEnumerable<FormKey> formKeys)
    {
        if (!Directory.Exists(sourceRoot)) return [];

        var unitsByTail = new Dictionary<string, int>(StringComparer.Ordinal);
        void Count(string leaf)
        {
            foreach (var tail in TailsCarriedBy(leaf))
            {
                unitsByTail[tail] = unitsByTail.GetValueOrDefault(tail) + 1;
            }
        }

        // Group-level files and block directories carry no FormKey, so they never match a tail and need no
        // exclusion.
        foreach (var directory in Directory.EnumerateDirectories(sourceRoot, "*", SearchOption.AllDirectories))
            Count(Path.GetFileName(directory));
        foreach (var file in Directory.EnumerateFiles(sourceRoot, $"*{JsonSuffix}", SearchOption.AllDirectories))
            Count(Path.GetFileName(file));

        var colliding = new List<string>();
        foreach (var formKey in formKeys)
        {
            var filesafe = LeafNameFor(formKey, editorId: null, isDirectory: true);
            var units = unitsByTail.GetValueOrDefault(filesafe)
                        + unitsByTail.GetValueOrDefault(filesafe + JsonSuffix);
            if (units > 1) colliding.Add(formKey.ToString());
        }
        return colliding;
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

    // Matches the FormKey alone, never the EditorID, which the index's copy may hold stale mid-rename.
    private static string? FindOwnUnit(
        IRecordReads reads, PluginKey plugin, string sourceRoot, string formKey, string recordType, GameRelease release,
        SourceUnitResolutionCache? cache)
    {
        var scanRoot = Path.Combine(sourceRoot, ScanSubtree(reads, plugin, formKey, recordType, release) ?? string.Empty);
        if (!Directory.Exists(scanRoot)) return null;

        var suffix = FilesafeFormKey(formKey);
        // With a cache the subtree is listed once and the pre-filter runs in memory; AsSourceUnitFile is the
        // real test either way.
        var candidates = cache == null
            ? Directory.EnumerateFileSystemEntries(scanRoot, $"*{suffix}*", SearchOption.AllDirectories)
            : cache.EntriesUnder(scanRoot).Where(e => Path.GetFileName(e).Contains(suffix, StringComparison.OrdinalIgnoreCase));
        var matches = candidates
            .Select(entry => AsSourceUnitFile(entry, suffix))
            .OfType<string>()
            .Take(2)
            .ToList();

        return matches.Count switch
        {
            0 => null,
            1 => matches[0],
            _ => throw new AmbiguousSourceUnitException(
                $"More than one source unit under '{scanRoot}' claims FormKey {formKey}. A FormKey is " +
                "unique within a mod, so this tree is corrupt — resolve the duplicate by hand before editing."),
        };
    }

    // A directory whose name carries the FormKey holds RecordData.json; a file whose name carries it is
    // the record.
    private static string? AsSourceUnitFile(string entry, string filesafeFormKey)
    {
        var leaf = Path.GetFileName(entry);

        if (Directory.Exists(entry))
        {
            if (!NameCarries(leaf, filesafeFormKey)) return null;
            var recordData = Path.Combine(entry, RecordDataFileName);
            return File.Exists(recordData) ? recordData : null;
        }

        return NameCarries(leaf, filesafeFormKey + JsonSuffix) ? entry : null;
    }

    /// <summary>Whether <paramref name="leaf"/> names the record with <paramref name="formKey"/> — asked
    /// in the one unambiguous direction, since an EditorID containing <c>" - "</c> makes splitting a
    /// name undecidable.</summary>
    internal static bool NameCarriesFormKey(string leaf, string formKey)
    {
        var filesafe = FilesafeFormKey(formKey);
        return NameCarries(leaf, filesafe) || NameCarries(leaf, filesafe + JsonSuffix);
    }

    // The whole-mod door's two name shapes: the filesafe FormKey alone, or "<EditorID> - " ahead of it.
    // Anchored at both ends so a name that merely embeds the text cannot match.
    private static bool NameCarries(string leaf, string tail) =>
        leaf.Equals(tail, StringComparison.Ordinal)
        || (leaf.EndsWith(tail, StringComparison.Ordinal)
            && leaf.EndsWith($" - {tail}", StringComparison.Ordinal));

    /// <summary>One place that knows a container is a directory and a flat record a file, so callers and
    /// the rollback cannot disagree.</summary>
    internal static void MoveEntry(string from, string to)
    {
        if (Directory.Exists(from)) Directory.Move(from, to);
        else File.Move(from, to);
    }

    /// <summary>Removes the directories this call minted when <paramref name="write"/> throws (#675): an
    /// empty record directory is invisible to git and fails the next ingest, since the reader opens
    /// every one unconditionally.</summary>
    internal static T InMintedDirectory<T>(string directory, Func<T> write)
    {
        var minted = new List<string>();
        for (var level = directory; !string.IsNullOrEmpty(level) && !Directory.Exists(level); level = Path.GetDirectoryName(level))
            minted.Add(level);

        try
        {
            Directory.CreateDirectory(directory);
            return write();
        }
        catch
        {
            // Deepest first, by construction of the walk above — so a parent is already empty by the
            // time it is reached, and needs no second pass.
            foreach (var stray in minted)
            {
                // Never reached (the create died at an ancestor): skip, so the levels that did land are still
                // removed.
                if (!Directory.Exists(stray)) continue;

                try { Directory.Delete(stray); }
                catch (DirectoryNotFoundException) { /* vanished under us; its ancestors still stand */ }
                catch (IOException) { break; }
                catch (UnauthorizedAccessException) { break; }
            }
            throw;
        }
    }

    /// <summary><see cref="InMintedDirectory{T}"/> for a write with no result of its own.</summary>
    internal static void InMintedDirectory(string directory, Action write) =>
        InMintedDirectory(directory, () => { write(); return true; });

    // The narrowing that keeps a point write off the full-tree walk. A Cell's subtree is not a property
    // of its type: interior under Cells, exterior under its worldspace, per the index's cell_location row.
    private static string? ScanSubtree(
        IRecordReads reads, PluginKey plugin, string formKey, string recordType, GameRelease release)
    {
        var dispatch = RecordTypeDispatch.For(release);
        if (dispatch.GroupFolderNameFor(recordType) is not { } folder)
        {
            // No group of its own: found under whatever holds its parent, so borrow the parent's subtree.
            var parent = reads.GetContainerParent(plugin, formKey);
            return parent == null
                ? null
                : ScanSubtree(reads, plugin, parent.Value.ParentFormKey, parent.Value.ParentRecordType, release);
        }

        // A cell lives under Cells or under its worldspace, never both; an absent row leaves the choice open.
        if (dispatch.ConcreteFor(recordType)?.Name == "Cell")
        {
            if (reads.GetCellLocation(plugin, formKey) is not { } location) return null;
            // The worldspace folder through the same dispatch table rather than a second literal, so
            // there is one place that knows what that directory is called.
            return location.ParentWorldspace == null ? folder : dispatch.GroupFolderNameFor("Worldspace");
        }

        return folder;
    }

    /// <summary><c>[&lt;EditorID&gt; - ]&lt;hex6&gt;_&lt;originModKey&gt;</c>, with <c>.json</c> for a flat
    /// file and without for a container's directory — the reason an EditorID edit is a rename.</summary>
    internal static string LeafNameFor(FormKey formKey, string? editorId, bool isDirectory)
    {
        var extension = isDirectory ? string.Empty : JsonSuffix;
        var filesafe = $"{formKey.ID:X6}_{formKey.ModKey.FileName}";

        return string.IsNullOrEmpty(editorId) ? $"{filesafe}{extension}" : $"{editorId} - {filesafe}{extension}";
    }

    private static string FilesafeFormKey(string formKey)
    {
        var parsed = FormKey.Factory(formKey);
        return $"{parsed.ID:X6}_{parsed.ModKey.FileName}";
    }
}

/// <summary>Two source units under one plugin's tree carry the same FormKey: corruption, not a
/// transient condition. An <see cref="InvalidOperationException"/> so the read path degrades on it;
/// only the write path refuses.</summary>
public sealed class AmbiguousSourceUnitException : InvalidOperationException
{
    public AmbiguousSourceUnitException() : base("More than one source unit claims one FormKey.")
    {
    }

    public AmbiguousSourceUnitException(string message) : base(message)
    {
    }

    public AmbiguousSourceUnitException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
