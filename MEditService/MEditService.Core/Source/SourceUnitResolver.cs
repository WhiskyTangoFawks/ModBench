using MEditService.Core.Records;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>
/// Which file holds a record, when that file is not the record's own — #453 scope 1.
/// </summary>
/// <param name="FullPath">The file to read and write. For a container or an embedded child this is a
/// file that was <i>found</i> on disk, because there is no path to compute for one. For a flat record
/// it is <see cref="SourceRecordPath.For"/>'s computed path, which may not exist — the caller's
/// existing never-assume-exclusive-ownership fallback (edit from the indexed body, rewrite the file)
/// is the right answer there and is deliberately left intact.</param>
/// <param name="RelativePath">The same file relative to the mod folder, for logging and for the
/// git-facing vocabulary the Source Control panel speaks.</param>
/// <param name="OwnerFormKey">The record whose document <paramref name="FullPath"/> <i>is</i> — the
/// requested record itself for a flat or directory-per-record type, or the container it is embedded
/// in.</param>
/// <param name="OwnerRecordType">The owner's <c>record_type</c>, which is what the codec needs to
/// read the file back.</param>
/// <param name="IsEmbedded">True when <paramref name="OwnerFormKey"/> is not the requested record —
/// i.e. the caller must reach into the owner's object graph to find what it asked for.</param>
internal readonly record struct SourceUnit(
    string FullPath, string RelativePath, string OwnerFormKey, string OwnerRecordType, bool IsEmbedded);

/// <summary>
/// The record→source-unit question, answered for <b>every</b> record shape the Spriggit layout has
/// (#453 scope 1; ADR-0041's #444 amendment, "one source unit = one file"). <see cref="SourceRecordPath"/>
/// answers it for flat records by computing a path; this answers it for the rest — containers, whose
/// directory nesting is not derivable from the index, and embedded children, which have no file at all.
///
/// <para><b>Why the disk and not a path map.</b> #453's scope note asked for a path map built at
/// ingest, on the premise that #452's extraction already walks this structure. It does not:
/// <see cref="SourceIngest.Ingest"/> hands the whole tree to the generated deserializer and the
/// resulting <c>IModGetter</c> to <see cref="IRecordIndex.Index"/>, so every extractor downstream
/// (<c>EnumerateMajorRecords</c>, <see cref="PlacementWalker"/>, <see cref="ContainerChildFields"/>)
/// walks an in-memory object graph with no path information in it. There is no walk to share, and
/// therefore no second walk to drift from it. The alternative — computing container paths from the
/// index — would need block/sub-block coordinates the index does not carry (<see cref="PlacementWalker"/>
/// passes <c>default</c> coords for interior cells) <i>and</i> a second copy of the serializer's own
/// directory-naming policy. Reading the disk needs neither: <b>it is the one source that cannot drift
/// from the serializer, because it is the serializer's own output</b> — which is also the
/// never-assume-exclusive-ownership answer, since anything may have moved a file since Modbench last
/// looked.
///
/// <para><b>What it costs, measured.</b> A full-tree scan of a tree the size of the #444 spike's
/// 20 MB mega-plugin (18,880 files / 31,145 directories) is <b>0.39 s warm</b> — a visible stall on
/// an interactive gesture. So the scan is narrowed twice. Flat records never scan at all
/// (<see cref="SourceRecordPath.For"/> computes their path, and it is tried first). A placed
/// reference never scans either — the index knows its cell outright. Everything else scans one
/// group subtree (<see cref="RecordTypeDispatch.GroupFolderNameFor"/>): measured <b>0.02 s</b> for
/// <c>Cells</c> and <b>0.06 s</b> for <c>Worldspaces</c>. The unnarrowed walk survives as the
/// fallback for a type nothing here can place, which is slow and correct rather than fast and
/// wrong.</para>
///
/// <para><b>Failure is loud in both directions.</b> No match returns null, which every caller turns
/// into a typed refusal — never a computed path that might be wrong. More than one match throws
/// <see cref="AmbiguousSourceUnitException"/>: a FormKey is unique within a mod, so two files
/// claiming one is a corrupt tree, and picking either would be a guess.</para>
/// </summary>
internal static class SourceUnitResolver
{
    /// <summary>The whole-mod door's own name for a directory-per-record container's field file
    /// (<c>SerializationHelper.RecordDataFileNameWithoutExtension</c> plus the JSON kernel's
    /// extension).</summary>
    internal const string RecordDataFileName = "RecordData.json";

    private const string JsonSuffix = ".json";

    /// <summary>
    /// <paramref name="formKey"/>'s source unit, or null when nothing on disk holds it and the index
    /// knows of no container that would.
    /// </summary>
    /// <param name="reads">The index, for the containment facts an embedded child's file cannot
    /// carry (<see cref="IRecordReads.GetPlacement"/>, <see cref="IRecordReads.GetContainerParent"/>,
    /// <see cref="IRecordReads.GetCellLocation"/>).</param>
    /// <param name="plugin">The plugin whose copy of the record is wanted.</param>
    /// <param name="modFolder">The tracked mod folder the source tree sits in.</param>
    /// <param name="formKey">The record to locate.</param>
    /// <param name="recordType">Its <c>record_type</c>, as the index has it.</param>
    /// <param name="editorId">Its EditorID, used only to compute a flat path — the scan matches on
    /// the FormKey suffix alone, so a stale EditorID can never send it to the wrong file.</param>
    /// <param name="release">The game release, for the folder-name reflection.</param>
    internal static SourceUnit? Resolve(
        IRecordReads reads, PluginKey plugin, string modFolder,
        string formKey, string recordType, string? editorId, GameRelease release)
    {
        // A flat record: SourceRecordPath computes the path exactly, so there is nothing to search
        // for. This is the overwhelmingly common edit and it pays nothing.
        try
        {
            var flat = SourceRecordPath.For(plugin.Name, recordType, formKey, editorId, release);
            return new SourceUnit(Path.Combine(modFolder, flat), flat, formKey, recordType, IsEmbedded: false);
        }
        catch (NotSupportedException)
        {
            // Not flat — a container, or a child with no top-level group of its own. Fall through.
        }

        // A placed reference is embedded in its cell by definition (Persistent/Temporary are two of
        // the five slots Spriggit embeds), and the index knows which cell outright — so this case
        // resolves with no scan at all, which matters because it is the most common container-shaped
        // edit there is.
        if (reads.GetPlacement(formKey, plugin) is { } placement)
            return ResolveOwner(reads, plugin, modFolder, placement.ParentCell, release);

        // Everything else may still have a file of its own — a Cell, a Worldspace, a Quest, a dialog
        // topic, a scene. Look for it before assuming it is embedded.
        var root = Path.Combine(modFolder, $"{plugin.Name}{SourceRecordPath.SourceSuffix}");
        if (FindOwnUnit(reads, plugin, root, formKey, recordType, release) is { } own)
        {
            return new SourceUnit(
                own, Path.GetRelativePath(modFolder, own), formKey, recordType, IsEmbedded: false);
        }

        // No file of its own, so it is embedded in a parent's document. Landscape and NavigationMeshes
        // arrive through container_child; a Worldspace's TopCell has no directory and arrives through
        // cell_location's own parent link.
        var parent = reads.GetContainerParent(plugin, formKey)?.ParentFormKey
                     ?? reads.GetCellLocation(plugin, formKey)?.ParentWorldspace;

        return parent == null ? null : ResolveOwner(reads, plugin, modFolder, parent, release);
    }

    /// <summary>
    /// The owner's own source unit, re-entered through <see cref="Resolve"/> so a container nested in
    /// another container needs no special case — and re-flagged as embedded, because whatever the
    /// owner's own shape turns out to be, the record the caller asked for is inside it rather than
    /// being it.
    ///
    /// <para>Not recursive without bound: the owner is looked up in the index, so a cycle would need
    /// the index to claim a record contains itself transitively, which no walk that produced those
    /// rows can express (<see cref="PlacementWalker"/> and <see cref="ContainerChildFields"/> both
    /// descend a tree). A missing owner row returns null and refuses, rather than spinning.</para>
    /// </summary>
    private static SourceUnit? ResolveOwner(
        IRecordReads reads, PluginKey plugin, string modFolder, string ownerFormKey, GameRelease release)
    {
        var owner = reads.GetDocument(ownerFormKey, plugin);
        if (owner == null) return null;

        return Resolve(reads, plugin, modFolder, ownerFormKey, owner.RecordType, owner.EditorId, release)
            is { } unit
            ? unit with { IsEmbedded = true }
            : null;
    }

    /// <summary>
    /// The record's own file, found by its FormKey suffix under the narrowest subtree that can hold
    /// it. Matching is on the FormKey alone — never the EditorID, which the index's copy of may be
    /// stale relative to the tree, and which is exactly the disagreement an EditorID edit creates
    /// mid-rename.
    /// </summary>
    private static string? FindOwnUnit(
        IRecordReads reads, PluginKey plugin, string sourceRoot, string formKey, string recordType, GameRelease release)
    {
        var scanRoot = Path.Combine(sourceRoot, ScanSubtree(reads, plugin, formKey, recordType, release) ?? string.Empty);
        if (!Directory.Exists(scanRoot)) return null;

        var suffix = FilesafeFormKey(formKey);
        var matches = Directory
            .EnumerateFileSystemEntries(scanRoot, $"*{suffix}*", SearchOption.AllDirectories)
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

    /// <summary>The file <paramref name="entry"/> is the source unit of, or null when it is not a
    /// source unit at all. A directory whose name carries the FormKey holds its record's fields in
    /// <c>RecordData.json</c>; a file whose name carries it is the record. Anything else the wildcard
    /// swept up — a group file, a stray temp file from an interrupted write — is not one.</summary>
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

    // The whole-mod door's own two name shapes (SerializationHelper.RecordFileNameProvider): the
    // filesafe FormKey alone when the record has no EditorID, or "<EditorID> - " ahead of it when it
    // does. Anchored at both ends rather than a bare Contains, so a name that merely happens to
    // embed the text cannot match.
    private static bool NameCarries(string leaf, string tail) =>
        leaf.Equals(tail, StringComparison.Ordinal)
        || (leaf.EndsWith(tail, StringComparison.Ordinal)
            && leaf.EndsWith($" - {tail}", StringComparison.Ordinal));

    /// <summary>
    /// The subtree to search, relative to the source root — the narrowing that keeps a point write off
    /// the 0.39 s full-tree walk (see this class's own doc comment for the measurements).
    ///
    /// <para>A Cell is the one type whose subtree is not a property of its type: an interior cell is
    /// under <c>Cells</c> and an exterior one under its worldspace, so the index's own
    /// <c>cell_location</c> row picks between them. Null means "no idea" — a type with no top-level
    /// group whose parent the index cannot name either — and falls back to the whole tree.</para>
    /// </summary>
    private static string? ScanSubtree(
        IRecordReads reads, PluginKey plugin, string formKey, string recordType, GameRelease release)
    {
        var dispatch = RecordTypeDispatch.For(release);
        if (dispatch.GroupFolderNameFor(recordType) is not { } folder)
        {
            // No group of its own (a landscape, a navmesh, a dialog topic, a scene). It will be found
            // under whatever holds its parent, so borrow the parent's subtree — and if the index has
            // no parent either, the caller's next step is the embedded branch anyway.
            var parent = reads.GetContainerParent(plugin, formKey);
            return parent == null
                ? null
                : ScanSubtree(reads, plugin, parent.Value.ParentFormKey, parent.Value.ParentRecordType, release);
        }

        // A cell lives under Cells or under its worldspace, never both. `parent_worldspace` is the
        // index's own answer, and an absent row (a cell this plugin did not index) leaves the choice
        // open rather than guessing one.
        if (dispatch.ConcreteFor(recordType)?.Name == "Cell")
        {
            if (reads.GetCellLocation(plugin, formKey) is not { } location) return null;
            // The worldspace folder through the same dispatch table rather than a second literal, so
            // there is one place that knows what that directory is called.
            return location.ParentWorldspace == null ? folder : dispatch.GroupFolderNameFor("Worldspace");
        }

        return folder;
    }

    /// <summary>
    /// The name a source unit's own file or directory carries — the whole-mod door's
    /// <c>SerializationHelper.RecordNameProvider</c>/<c>RecordFileNameProvider</c> scheme:
    /// <c>[&lt;EditorID&gt; - ]&lt;hex6&gt;_&lt;originModKey&gt;</c>, with <c>.json</c> for a flat
    /// record's file and without for a container's directory. Shared with
    /// <see cref="SourceRecordPath"/>'s own flat construction by construction of the same two parts,
    /// and the reason an EditorID edit is a rename at all.
    /// </summary>
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

/// <summary>Thrown when two source units under one plugin's tree carry the same FormKey. Named rather
/// than a bare <see cref="InvalidOperationException"/> because it says something specific and
/// actionable about the tree — a FormKey is unique within a mod, so this is corruption to resolve by
/// hand, not a transient condition to retry.</summary>
public sealed class AmbiguousSourceUnitException : Exception
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
