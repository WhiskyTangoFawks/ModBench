using MEditService.Core.Records;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>
/// Which file holds a record, when that file is not the record's own.
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
    string FullPath, string RelativePath, string OwnerFormKey, string OwnerRecordType, bool IsEmbedded)
{
    /// <summary>
    /// True when <see cref="FullPath"/> is a directory-per-record container's own field file (a
    /// Cell/Worldspace/Quest, or a nested folder-split child such as a Quest's DialogTopic) rather
    /// than a flat record's single file. One definition here rather than each call site
    /// (<c>RecordEditService.RenameSourceUnit</c>, <c>DeleteRecord</c>,
    /// <c>RenumberTheRecordItself</c>) retyping the test — alongside <see cref="IsEmbedded"/>,
    /// which <see cref="SourceUnit"/> already carries the same way.
    ///
    /// <para><b>The header's own root <c>RecordData.json</c> (#661) is excluded explicitly, not by
    /// the filename test alone.</b> The whole-mod door's group-level file name
    /// (<see cref="SourceUnitResolver.RecordDataFileName"/>) is shared between two shapes: a
    /// container's field file, sitting one level <i>under</i> the plugin's own source root, and the
    /// header's document, sitting <i>at</i> it — the filename test alone cannot tell them apart, and
    /// answering true for the header is not a theoretical risk: it was a real, reviewer-caught defect
    /// (a header <c>DeleteRecord</c> deleting the plugin's own source root as "one record's" delete).
    /// <see cref="OwnerRecordType"/> is what actually distinguishes them — a container's is its own
    /// concrete type, the header's is always <c>HeaderIndexer.RecordType</c> — so this checks that
    /// rather than trusting the filename in isolation. Every one of the three call sites this
    /// property's own doc names is expected to answer correctly for the header now, not just the ones
    /// a caller happened to guard separately.</para>
    /// </summary>
    internal bool IsDirectoryPerRecord =>
        OwnerRecordType != HeaderIndexer.RecordType
        && Path.GetFileName(FullPath).Equals(SourceUnitResolver.RecordDataFileName, StringComparison.Ordinal);
}

/// <summary>
/// The record→source-unit question, answered for <b>every</b> record shape the source layout has
/// (ADR-0041 amendment: one source unit is one file). <see cref="SourceRecordPath"/>
/// answers it for flat records by computing a path; this answers it for the rest — containers, whose
/// directory nesting is not derivable from the index, embedded children, which have no file at all,
/// and the header (#661), whose one fixed path (the root <c>RecordData.json</c>) needs no derivation
/// at all.
///
/// <para><b>Why the disk and not a path map.</b> A path map built at
/// ingest would presume ingest's extraction already walks this structure. It does not:
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
/// <para><b>What it costs, measured.</b> A full-tree scan of a
/// 20 MB mega-plugin's tree (18,880 files / 31,145 directories) is <b>0.39 s warm</b> — a visible stall on
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
        string formKey, string recordType, string? editorId, GameRelease release,
        SourceUnitResolutionCache? cache = null)
    {
        // The header's own source unit: the root RecordData.json, one level above every group
        // folder (#661). It needs none of the machinery below — no order index or EditorID to
        // compute a flat path from (the file name never varies), never a placement or an embedded
        // child, and no group folder to scan if the computed path is stale, because there is
        // nothing to compute: the path is fixed. This is also why every branch below always
        // answered null for it before this ticket, traced at plan time: FlatSourcePath throws
        // (SourceRecordPath.For has no folder for a synthetic type), GetPlacement is null, and
        // FindOwnUnit's own FormKey-suffix scan can never match a file with no FormKey in its name.
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

        // A placed reference is embedded in its cell by definition (Persistent/Temporary are two of
        // the five slots Spriggit embeds), and the index knows which cell outright — so this case
        // resolves with no scan at all, which matters because it is the most common container-shaped
        // edit there is.
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

    /// <summary>
    /// Where a <b>flat</b> record's file actually is: <see cref="SourceRecordPath.For"/>'s computed
    /// path when that file exists, otherwise whichever file in the same group folder carries this
    /// FormKey, and failing both the computed path anyway.
    ///
    /// <para><b>The filename's EditorID and the document's EditorID are not guaranteed to agree, and
    /// resolution must not assume they do.</b> A tracked plugin's indexed EditorID comes
    /// from the file's <i>content</i>; the file <i>name</i> carries whatever EditorID it had when it
    /// was last written. Nothing keeps those in step. Two ordinary things pull them apart: a
    /// user or another tool editing <c>EditorID</c> inside a source file with their own editor — the
    /// standing never-assume-exclusive-ownership case, and the likelier of the two — and a crash
    /// between <c>RecordEditService</c>'s rename and the content write that follows it.</para>
    ///
    /// <para>Computing the path from the indexed EditorID and stopping there turns either of those
    /// into a <i>false deletion</i>: the file is not where the name says, so <c>File.Exists</c> is
    /// false, and both this class's caller and <see cref="SourceFreshness"/> would read "absent" as
    /// "the user deleted this record" and mark a live record gone at Effective. Resolution therefore
    /// leans on the FormKey, which is the stable half of the name — the FormKey in the suffix keeps
    /// resolution stable mid-rename.</para>
    ///
    /// <para><b>It costs nothing when nothing is wrong.</b> The fallback runs only when the computed
    /// path is absent, and it lists <i>one</i> group directory non-recursively — never the tree walk
    /// the container path takes. A record that is genuinely gone still resolves to its computed path,
    /// so the caller's existing "edit from the indexed body and rewrite the file" recovery is
    /// untouched.</para>
    ///
    /// <para><b>The ordering prefix shrank the guess's hit rate, and did not remove it.</b> <see cref="SourceRecordPath.For"/>
    /// needs the record's order index to compute an exact name, which this method does not have
    /// without a scan — so the "computed" guess below is index 0 specifically, which still resolves
    /// with zero scan for every group that has exactly one member (common) or whose first-ever sibling
    /// is being looked up right after a fresh create (also common). Every other position falls straight
    /// through to the same one-directory, non-recursive suffix scan below, which is FormKey-suffix
    /// matching (<see cref="NameCarries"/>) and blind to position.</para>
    /// </summary>
    internal static string FlatSourcePath(
        string modFolder, string pluginFileName, string recordType, string formKey, string? editorId,
        GameRelease release)
    {
        var computed = Path.Combine(
            modFolder, SourceRecordPath.For(pluginFileName, recordType, formKey, editorId, release, orderIndex: 0));
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

    /// <summary>
    /// Which of <paramref name="formKeys"/> more than one source unit in the tree claims — the
    /// FormKey-collision refusal, which compile cannot ask the deserialized mod because by then the
    /// answer is already gone.
    ///
    /// <para><b>Why this cannot be a duplicate scan over the compiled mod.</b> The whole-mod reader
    /// ends every group with <c>group.RecordCache.SetTo(x =&gt; x.FormKey, records)</c>
    /// (<c>GroupParallelHelper.ReadFilePerRecord</c> in <c>references/mutagen-serialization</c>), a
    /// FormKey-keyed cache: two files in <i>one</i> group folder claiming one FormKey collapse to the
    /// last one read, silently, before compile ever sees the mod. That is data loss in the user's
    /// binary — a record they can see in their tree and cannot find in the plugin — so the question has
    /// to be asked of the <i>tree</i>. Two files in <i>different</i> group folders survive as two
    /// records and would be catchable either way; this covers both with one mechanism.</para>
    ///
    /// <para>Reachable, not theoretical: a half-completed rename, another tool duplicating a file, a
    /// partially restored backup, or a user copying a record
    /// file to experiment (root CLAUDE.md's never-assume-exclusive-ownership rule).
    /// <see cref="Resolve"/>'s own <see cref="AmbiguousSourceUnitException"/> exists for exactly this
    /// state on the write path.</para>
    ///
    /// <para><b>One tree walk, not one per record.</b> <see cref="NameCarries"/> answers "does this leaf
    /// carry this FormKey" for a leaf/FormKey pair; asking it for every record against every leaf is
    /// quadratic on a tree with thousands of both. <see cref="TailsCarriedBy"/> inverts it — enumerating
    /// the tails a leaf carries, by exactly <see cref="NameCarries"/>' own two rules — so the walk builds
    /// a count per tail once and each record becomes a dictionary lookup.</para>
    /// </summary>
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

        // A directory-per-record container is named for its record; a flat record is a .json file named
        // for its record. The group-level files (RecordData.json, GroupRecordData.json) and the
        // block/sub-block directories ("0", "3, -4") carry no FormKey, so they simply never match a tail
        // below and need no exclusion of their own.
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

    /// <summary>The tails <paramref name="leaf"/> carries under <see cref="NameCarries"/> — the whole
    /// name (order prefix stripped), plus whatever follows each <c>" - "</c> in it. More than one
    /// candidate arises only when an EditorID itself contains <c>" - "</c>, which is legal and is
    /// precisely why a file name cannot be split into EditorID and FormKey unambiguously (see
    /// <see cref="SourceRecordIdentity"/>'s own doc comment); counting every candidate costs nothing,
    /// because a candidate that is not a real filesafe FormKey is never looked up.</summary>
    private static IEnumerable<string> TailsCarriedBy(string leaf)
    {
        var trimmed = WithoutOrderPrefix(leaf);
        yield return trimmed;

        const string separator = " - ";
        var at = trimmed.IndexOf(separator, StringComparison.Ordinal);
        while (at >= 0)
        {
            yield return trimmed[(at + separator.Length)..];
            at = trimmed.IndexOf(separator, at + separator.Length, StringComparison.Ordinal);
        }
    }

    /// <summary>
    /// The record's own file, found by its FormKey suffix under the narrowest subtree that can hold
    /// it. Matching is on the FormKey alone — never the EditorID, which the index's copy of may be
    /// stale relative to the tree, and which is exactly the disagreement an EditorID edit creates
    /// mid-rename.
    /// </summary>
    private static string? FindOwnUnit(
        IRecordReads reads, PluginKey plugin, string sourceRoot, string formKey, string recordType, GameRelease release,
        SourceUnitResolutionCache? cache)
    {
        var scanRoot = Path.Combine(sourceRoot, ScanSubtree(reads, plugin, formKey, recordType, release) ?? string.Empty);
        if (!Directory.Exists(scanRoot)) return null;

        var suffix = FilesafeFormKey(formKey);
        // With a cache the subtree is listed once for the whole operation and the wildcard's
        // "leaf contains the FormKey" pre-filter runs in memory; AsSourceUnitFile is the real test
        // either way, so the two paths cannot disagree on what is a source unit.
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
    // embed the text cannot match. The leading "[N] " ordering prefix is stripped first, so
    // FormKey-suffix matching stays exactly as blind to a record's position as it always was.
    private static bool NameCarries(string leaf, string tail)
    {
        var trimmed = WithoutOrderPrefix(leaf);
        return trimmed.Equals(tail, StringComparison.Ordinal)
            || (trimmed.EndsWith(tail, StringComparison.Ordinal)
                && trimmed.EndsWith($" - {tail}", StringComparison.Ordinal));
    }

    /// <summary>Strips a leading <c>"[N] "</c> ordering prefix when <paramref name="leaf"/>
    /// genuinely has one — never on a false positive, so an EditorID that happens to start with a
    /// bracketed number of its own (legal, if unusual) is left alone.</summary>
    internal static string WithoutOrderPrefix(string leaf) =>
        TryGetOrderIndex(leaf) is null ? leaf : leaf[(leaf.IndexOf("] ", StringComparison.Ordinal) + 2)..];

    /// <summary>
    /// The <c>"[N] "</c> ordering prefix <paramref name="leaf"/> carries, or null when it has
    /// none — used both to recognise one (<see cref="WithoutOrderPrefix"/>,
    /// <see cref="NextOrderIndex"/>) and to carry an existing sibling's own index across a rename
    /// (<see cref="Edits.RecordEditService.RenameSourceUnit"/>: an EditorID edit must not silently drop
    /// a record back to the front of its siblings). Mirrors what the whole-mod door's own reader does
    /// for the same reason (<c>SerializationHelper.TrimOrdering</c>/<c>TryGetNumber</c> in the
    /// decompiled 1.37.1 assembly), reimplemented rather than shared because neither is public API.
    /// </summary>
    internal static int? TryGetOrderIndex(string leaf)
    {
        if (leaf.Length == 0 || leaf[0] != '[') return null;
        var closeBracket = leaf.IndexOf("] ", StringComparison.Ordinal);
        if (closeBracket < 2) return null;
        return int.TryParse(leaf.AsSpan(1, closeBracket - 1), out var number) ? number : null;
    }

    /// <summary>
    /// The index a brand-new sibling should carry — one past the highest
    /// <c>"[N] "</c> prefix already present in <paramref name="groupDirectory"/> (0 for an empty or
    /// not-yet-created folder). <see cref="RenormalizeGroupOrder"/> keeps every group directory
    /// gap-free as its own last file-system act after every structural write, so max+1 and the plain
    /// sibling <i>count</i> coincide in the steady state — max+1 stays the expression here regardless,
    /// because it also does the right thing (still no collision, no premature renormalization needed)
    /// on a directory this call cannot itself prove is gap-free: one Modbench has not yet renormalized
    /// mid-write, or one an external tool left mid-edit (root CLAUDE.md's
    /// never-assume-exclusive-ownership rule) — count alone would collide against a real higher "[N]"
    /// in either of those, max+1 never does.
    /// </summary>
    internal static int NextOrderIndex(string groupDirectory)
    {
        if (!Directory.Exists(groupDirectory)) return 0;

        var highest = -1;
        foreach (var entry in Directory.EnumerateFileSystemEntries(groupDirectory))
        {
            if (TryGetOrderIndex(Path.GetFileName(entry)) is int number && number > highest)
                highest = number;
        }

        return highest + 1;
    }

    /// <summary>
    /// Closes whatever gap a structural write (delete, renumber's delete+create, or a
    /// defensively-checked create) just left or could have inherited — a gap-leaving
    /// delete would otherwise permanently break that plugin's Save &amp; Compile (round-trip
    /// regenerates canonical
    /// <c>"[N]"</c> prefixes as contiguous list position, which a gap can never match).
    /// <see cref="Edits.RecordEditService"/>'s three structural-write entry points call this as their
    /// own last file-system act, so a group directory is contiguous <c>[0..k]</c> again by the time any
    /// of them returns — the source tree's own working invariant (this class's own doc comment) stays
    /// true, rather than being merely restorable by a re-Track.
    ///
    /// <para><b>Renaming smallest-rank-first is always collision-free — the proof, so the next reader
    /// does not have to re-derive it.</b> Sort survivors by their <i>current</i> index ascending; a
    /// survivor's rank <c>i</c> among them is its new index. For the <c>i</c>-th smallest old index,
    /// there are exactly <c>i</c> other survivors with a strictly smaller old index, all distinct
    /// non-negative integers, so the old index is always <c>&gt;= i</c> — the new index (rank) can
    /// never exceed the old one. That means the destination name <c>"[i] ..."</c> is, for every rename
    /// in ascending-rank order, either a genuine gap nothing occupies yet, or the name an earlier
    /// (smaller-rank, already-processed) rename in this very pass just vacated — never a name a
    /// still-to-be-renamed survivor is sitting on. No temp-name shuffle is needed, and nothing here can
    /// produce a transient duplicate <c>"[i]"</c>.</para>
    ///
    /// <para>Survivors' relative order is preserved by construction: sorting by old index ascending and
    /// assigning ranks ascending cannot reorder anyone relative to anyone else, whether or not gaps
    /// existed. Only the tail after <c>"] "</c> is ever touched by <see cref="TryGetOrderIndex"/>'s own
    /// parse — the EditorID/FormKey segment a survivor's name carries is never altered, only its own
    /// index prefix.</para>
    ///
    /// <para><b>Fail-safe by construction, not by any new journal.</b> This is the last file-system act
    /// of the write that called it; a crash mid-pass leaves a
    /// half-renumbered group, which <see cref="Edits.PluginCompileService"/>'s existing byte-exact
    /// round-trip gate already refuses correctly (some sibling's canonical name will not match
    /// what is on disk) — the same "re-Track to repair" recovery that gate has always offered, needing
    /// nothing new to keep offering it here.</para>
    /// </summary>
    internal static void RenormalizeGroupOrder(string groupDirectory)
    {
        if (!Directory.Exists(groupDirectory)) return;

        var survivors = Directory.EnumerateFileSystemEntries(groupDirectory)
            .Select(entry => (Entry: entry, Index: TryGetOrderIndex(Path.GetFileName(entry))))
            .Where(s => s.Index is not null)
            .OrderBy(s => s.Index!.Value)
            .ToList();

        for (var newIndex = 0; newIndex < survivors.Count; newIndex++)
        {
            var (entry, oldIndex) = survivors[newIndex];
            if (oldIndex == newIndex) continue;

            var leaf = Path.GetFileName(entry);
            var tail = leaf[(leaf.IndexOf("] ", StringComparison.Ordinal) + 2)..];
            var newPath = Path.Combine(groupDirectory, $"[{newIndex}] {tail}");

            if (Directory.Exists(entry)) Directory.Move(entry, newPath);
            else File.Move(entry, newPath);
        }
    }

    /// <summary>
    /// <see cref="NextOrderIndex"/>, given a flat record type rather than an already-computed group
    /// directory — the two call sites that mint a brand-new flat-record file
    /// (<see cref="Edits.RecordEditService.CreateRecord"/> and <see cref="Edits.RecordEditService.RenumberRecord"/>'s
    /// own delete+create) both need "where does this type's group folder live" answered the same way,
    /// and duplicating that <c>Path.Combine</c>/<c>FolderNameFor</c> pair at each site is exactly the
    /// kind of drift this class exists to prevent. Callers must already know <paramref name="recordType"/>
    /// has a flat group folder (both do, having passed <c>RefuseIfContainerType</c> first) — this does
    /// not re-check, so a caller that hasn't would NRE on the null-forgiving <c>FolderNameFor</c> rather
    /// than fail closed silently. Both callers also renormalize their own group directory
    /// afterward, so a gap this returns into is transient at worst, closed before either call returns.
    /// </summary>
    internal static int NextOrderIndexFor(string modFolder, string pluginFileName, string recordType, GameRelease release)
    {
        var groupDirectory = Path.Combine(
            modFolder, SourceRecordPath.RootFor(pluginFileName),
            RecordTypeDispatch.For(release).FolderNameFor(recordType)!);
        return NextOrderIndex(groupDirectory);
    }

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

/// <summary>Thrown when two source units under one plugin's tree carry the same FormKey — a FormKey is
/// unique within a mod, so this is corruption to resolve by hand, not a transient condition to retry.
///
/// <para>Derives from <see cref="InvalidOperationException"/> rather than <see cref="Exception"/> so
/// that the read path already degrades on it: <see cref="SourceFreshness.Validate"/>'s catch list
/// names that type, and a corrupt tree must not turn a record <i>read</i> into a thrown error — it
/// serves what the index has, logs, and leaves the write path to refuse. Still its own named type
/// because the message is specific and actionable in a way a bare invalid-operation is not.</para></summary>
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
