using System.Globalization;
using System.Text;
using System.Text.Json;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Plugins.Utility;

namespace MEditService.Core.Edits;

/// <summary>
/// The single write path (ADR-0041): a field edit on a tracked plugin becomes a working-tree
/// change to that record's source JSON, and nothing else. There is no second path — no direct binary
/// write, no staged intermediate state — which is why an untracked plugin is refused here rather than
/// quietly served by some other mechanism.
///
/// <para><b>The source text is the source, not the index.</b> Each edit reads the record's source
/// file, applies the field to the record that text deserializes to, and writes the file back; the
/// index is then told what landed. Reading the file rather than the indexed body is deliberate and
/// measured: a plugin's <i>binary overlay</i> and a <i>deep parse</i> of its source are not always
/// structurally identical (a measured 1-in-3,940 hole,
/// documented on <see cref="GitBlobHash"/>). Editing the file's own bytes means an edit can never
/// silently rewrite a record's unrelated fields into the overlay's shape.</para>
///
/// <para>That specific hazard cannot arise for a <b>tracked</b> plugin — which is every plugin this
/// class will edit, since editing requires tracking. Its index rows are seeded from the same
/// source tree this reads, so there is exactly one parse and the two cannot disagree
/// (<c>SourceIngestParityTests</c> measures the residue: 2,576 of 2,577 real documents byte-identical,
/// the one exception only reachable on the untracked binary path). Reading
/// the file nonetheless stays correct and stays the rule: it is the shortest path to the bytes being
/// edited, and it keeps this class independent of how fresh the index happens to be.</para>
///
/// <para>Every refusal happens <b>before</b> anything is written, so a refused edit leaves the
/// working tree exactly as it was — there is no half-applied state for the user to discover in the
/// Source Control panel.</para>
/// </summary>
public sealed class RecordEditService(
    ILoadOrderMirror mirror,
    SchemaReflector schemaReflector,
    ILogger<RecordEditService> logger)
{
    private readonly RecordTextCodec _codec = new(Microsoft.Extensions.Logging.Abstractions.NullLogger<RecordTextCodec>.Instance);

    // #607: the exterior-cell/worldspace-override mint cluster is spatial logic beside this class's
    // own field-edit plumbing (ADR-0041's "one write path" still holds — this is composition, not a
    // second path); RecordCopy owns it, sharing this instance's own mirror/schemaReflector so its
    // writes are indistinguishable from one this class made directly. Its own codec instance, the
    // same trivial one-liner _codec above uses — a field initializer cannot reference another
    // instance field, and RecordTextCodec carries no state worth sharing across the two.
    private readonly RecordCopy _recordCopy = new(
        mirror, schemaReflector, logger, new RecordTextCodec(Microsoft.Extensions.Logging.Abstractions.NullLogger<RecordTextCodec>.Instance));

    /// <summary>
    /// Applies <paramref name="value"/> to <paramref name="fieldPath"/> on one plugin's copy of
    /// <paramref name="formKey"/>. Complex fields arrive as one whole value (CONTEXT.md's atomic
    /// field-level write), VMAD and condition paths included — see <see cref="RecordFieldWriter"/>
    /// for the dispatch.
    /// </summary>
    public RecordEditResult EditField(PluginKey plugin, string formKey, string fieldPath, JsonElement value)
    {
        if (ResolveEditTarget(plugin, formKey, out var editTarget) is { } blocked) return blocked;
        // modFolder isn't needed past resolution here — EditField's own remaining work is entirely
        // in terms of the record's own source unit, not the mod folder that produced it.
        var (index, _, release, document, unit) = editTarget;
        var schemas = schemaReflector.GetSchemas(release);

        // #661: the header is a source unit now, so ResolveEditTarget above no longer refuses it at
        // SourceUnitNotFound before this line — but a ModHeader is not an IMajorRecord, so it can
        // never flow through ReadRecordFromSource/RecordFieldWriter's generic per-record pipeline
        // below (that pipeline is what every other record type uses, and structurally cannot carry
        // this one — see HeaderDocument's own doc comment). Answered here instead, off the schema
        // alone, before any record is read or materialized.
        if (document.RecordType == HeaderIndexer.RecordType)
            return RefuseHeaderFieldEdit(fieldPath, schemas);

        var reads = index.At(RecordRef.Effective);
        var owner = reads.GetDocument(unit.OwnerFormKey, plugin)!;
        var record = ReadRecordFromSource(_codec, logger, unit.FullPath, owner, release);

        // The record the field lands on is the one the caller named — which is *inside* `record` when
        // the source unit belongs to a container. Locating it in the parent's own object graph rather
        // than by a JSON path is what keeps this on the same machinery as every other edit: the child
        // is a real Mutagen record, so RecordFieldWriter applies to it unchanged, and reserializing
        // the parent writes it back with every untouched byte intact.
        var target = record;
        if (unit.IsEmbedded)
        {
            if (ContainerChildFields.FindEmbeddedChild(record, formKey) is not { } found)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    // Deliberately does not blame an external change — a defect here (a child the
                    // search failed to descend to) reads identically, and a wrong explanation is
                    // worse than none: it sends the user hunting a problem that is not there.
                    // States only what is observed.
                    $"{unit.RelativePath} is indexed as holding {formKey}, but its own text does not " +
                    "carry it. If nothing outside Modbench changed that file, this is a defect — please " +
                    "report it; otherwise relaunch mEdit so the index re-reads the tree.");
            }
            target = found.Child;
        }

        if (RefuseIfContainmentField(document.RecordType, fieldPath, schemas, release) is { } containmentRefusal)
            return containmentRefusal;

        // A Partial Form override's own fields are read-only — checked against `target`, not
        // `record`, so an embedded child (a REFR the override introduces) is unaffected: it is never
        // itself a container type, so PartialFormFlag.IsSet is false for it regardless of its
        // parent's own flag (CONTEXT.md's Partial Form entry: "children are unaffected — they are
        // separate records"). EditorID is exempt: xEdit's own CanAssignInternal
        // (wbImplementation.pas:9905-9914) explicitly allows EDID assignment on a Partial Form
        // record, and ADR-0034 makes xEdit's answer binding here. is_partial_form is exempt too:
        // it is the one write that must reach the flag while it is set — clearing it is the
        // only way out of this very refusal.
        if (PartialFormFlag.IsSet(target)
            && !fieldPath.Equals(RecordFieldWriter.EditorIdFieldPath, StringComparison.Ordinal)
            && !fieldPath.Equals(RecordFieldWriter.IsPartialFormFieldPath, StringComparison.Ordinal))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.PartialFormFieldReadOnly,
                $"{formKey} is a Partial Form override — its own fields are ignored for conflict " +
                "resolution and read-only here. Editing this record requires clearing the Partial " +
                "Form flag on its header first.");
        }

        if (ValidateFormLinks(reads, schemas, document.RecordType, fieldPath, value, release) is { } linkError)
            return RecordEditResult.Refused(RecordEditRefusal.InvalidFormLink, linkError);

        // Two reflected columns (major_flags, fallout4_major_record_flags — and,
        // structurally, any other column Mutagen's own MajorRecordFlags-passthrough convention
        // generates on some other game's record type) read and write the very same MajorRecordFlagsRaw
        // int bit 14 lives in. is_partial_form is meant to be the one sanctioned door onto that bit,
        // so rather than naming those columns (which would silently miss the next game's own alias),
        // this checks the invariant structurally: bit 14 must not move through any field path other
        // than is_partial_form. The before-value is captured here so there is something to compare
        // against once the write below runs; the comparison itself happens after a successful apply
        // but well before this record's bytes reach disk, so a caught violation leaves the working
        // tree untouched — the mutated in-memory record is a throwaway (this class's own doc comment)
        // and is simply never serialized.
        var checkBit14Leak = !fieldPath.Equals(RecordFieldWriter.IsPartialFormFieldPath, StringComparison.Ordinal)
            && PartialFormFlag.IsPartialFormable(target.GetType());
        var bit14Before = checkBit14Leak ? target.MajorRecordFlagsRaw & PartialFormFlag.Bit : 0;

        var outcome = RecordFieldWriter.TryApply(target, document.RecordType, fieldPath, value, schemas, release);
        // #630: a boundary array op (remove past the end, move the first element up / the last
        // down) — already fully "satisfied" with nothing to commit. Returned before the bit-14 leak
        // check and every write below (rename, re-serialize, ApplyWorkingTreeChanges, ReapplyFilter)
        // so a boundary no-op leaves the working tree exactly as it was: no dirty file, no spurious
        // history entry, matching this class's own "nothing written before/unless applied" contract
        // for every genuine refusal.
        if (outcome == FieldApplyOutcome.NoOp)
            return RecordEditResult.Success();
        if (outcome != FieldApplyOutcome.Applied)
            return RefuseFieldOutcome(outcome, fieldPath, document.RecordType, schemas);

        if (checkBit14Leak && (target.MajorRecordFlagsRaw & PartialFormFlag.Bit) != bit14Before)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.PartialFormFlagIndirectWrite,
                $"'{fieldPath}' would change record header flag bit 14 (Partial Form) as a side " +
                "effect of writing an unrelated column. That bit is only writable through " +
                "'is_partial_form' — nothing was written.");
        }

        // The file name carries the EditorID, so an EditorID edit is a rename as well as
        // a content change. Done before the write, deliberately — see RenameSourceUnit.
        var sourcePath = RenameSourceUnit(unit, target, document);

        // The codec's own file write is atomic (temp file, then rename), which matters more
        // here than at Track — this file is inside a live git working tree that the SCM panel, and
        // git itself, may read at any moment.
        var newBody = SerializeAndWrite(_codec, record, sourcePath, release);

        // An embedded edit dirties *two* rows — the parent source unit, whose bytes
        // moved, and the child, whose own document is what the read model serves for it. Both go
        // through the one ApplyWorkingTreeChanges call, so they land in a single transaction.
        var deltas = new List<(string FormKey, string? Body)>
        {
            (unit.OwnerFormKey, newBody),
        };
        if (unit.IsEmbedded)
        {
            deltas.Add((formKey, Encoding.UTF8.GetString(
                _codec.SerializeToBytesAsync(target, release).GetAwaiter().GetResult())));
        }
        index.ApplyWorkingTreeChanges(plugin, deltas);

        // The new value can flip filter membership either way.
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Edited {FieldPath} on {FormKey} in {Plugin} ({Origin}) — working-tree change written to {SourcePath}",
                fieldPath, formKey, plugin.Name, plugin.Origin, unit.RelativePath);
        }
        return RecordEditResult.Success();
    }

    /// <summary>
    /// Refuses the handful of fields on a container whose truth does <b>not</b> live in the document
    /// alone — the containment guard, and the reason no index side table can go stale through
    /// a field edit.
    ///
    /// <para>Reflection makes a container's child slots ordinary writable columns:
    /// <c>Cell.{Landscape,NavigationMeshes}</c> and <c>Worldspace.{TopCell,SubCells}</c> all reflect as
    /// struct/array columns with an <c>Apply</c>. Writing one
    /// would replace a container's <i>child set</i> through a JSON blob: the replaced children keep
    /// their own <c>records</c> rows and their <c>container_child</c> parentage while no longer being
    /// in any parent, which is silent index corruption rather than an edit. Changing which records a
    /// container holds is a structural gesture, not a field write, and "containment is
    /// the path" is ADR-0041 talking — so the path, not a field, is what expresses
    /// it.</para>
    ///
    /// <para><c>Cell.Grid</c> is refused for the neighbouring reason: an exterior cell's grid
    /// coordinates <i>are</i> its directory (<c>Worldspaces/&lt;ws&gt;/&lt;X, Y&gt;/&lt;X, Y&gt;/…</c>),
    /// so moving it is a tree restructure and not a rewrite of one file, and the same two numbers are
    /// mirrored in <c>cell_location</c>, which nothing on this path re-derives. Compile
    /// <i>reads</i> that structure; nothing <i>moves</i> a record within it —
    /// the same structural-gesture reason as the slot columns above.</para>
    ///
    /// <para><b>This is what closes the side-table question, and it closes it completely rather than
    /// per-table.</b> <c>cell_location</c>'s only non-containment columns are the grid, refused here.
    /// <c>container_child</c> is containment and slot order throughout, and the slots that could
    /// change it are refused here too. <c>placement</c>'s only non-containment column is
    /// <c>Position</c> (a <c>P3Float</c>) — also refused here: the schema
    /// reflector's general <c>P3Int16</c>/<c>P3Float</c> mapping (needed for <c>ObjectBounds</c> and
    /// several other fields with no side-table mirror) makes <c>Position</c> an ordinary
    /// writable column on every <c>IPlacedGetter</c> type, so
    /// the guard below is what keeps the conclusion true. After this guard, every side table is
    /// unreachable from <see cref="EditField"/> by construction — which is a stronger statement than
    /// re-deriving them would have been, and it is the reason this method exists instead of a
    /// <c>SetPlacement</c>-style write-back.</para>
    /// </summary>
    private static RecordEditResult? RefuseIfContainmentField(
        string recordType, string fieldPath, IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release)
    {
        if (!schemas.TryGetValue(recordType, out var schema)) return null;
        if (schema.RecordColumns.FirstOrDefault(c => c.Name == fieldPath) is not { } column) return null;
        if (RecordTypeDispatch.For(release).ConcreteFor(recordType) is not { } concrete) return null;

        // The property name from the schema's own column, never a hand-rolled snake_case reversal, so
        // this guard and the reflector cannot disagree about which CLR property a field path names.
        if (ContainerChildFields.EnumerateChildFieldsFor(concrete) is { } childSlots
            && childSlots.Contains(column.PropertyName, StringComparer.Ordinal))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FieldReadOnly,
                $"'{fieldPath}' holds {recordType}'s child records, and containment is expressed by the " +
                "source tree's own structure rather than by a field (ADR-0041). Adding, removing or " +
                "reordering a container's children is a structural gesture, not a field edit.");
        }

        if (column.PropertyName.Equals("Grid", StringComparison.Ordinal)
            && ContainerChildFields.NormalizedTypeName(concrete).Equals("Cell", StringComparison.Ordinal))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FieldReadOnly,
                "'grid' is an exterior cell's own place in the world — its source directory is named " +
                "after these coordinates, so moving it restructures the tree rather than rewriting one " +
                "file. That is a structural gesture, not a field edit.");
        }

        // Position is mirrored into the `placement` side table (PlacementWalker), with no
        // write-time re-derivation — the same hazard Grid guards against for cell_location. Resolved
        // through the game's own IPlacedGetter marker interface (same namespace/assembly as `concrete`
        // — the per-game-generic lookup this file already uses via RecordTypeDispatch, rather than a
        // hardcoded FO4 type list), not a hardcoded record-type name, so this holds for whichever
        // concrete types a game module gives Position to (APlacedTrap/PlacedNpc/PlacedObject in
        // Fallout4 today).
        if (column.PropertyName.Equals("Position", StringComparison.Ordinal)
            && concrete.Assembly.GetType($"{concrete.Namespace}.IPlacedGetter") is { } placedGetterType
            && placedGetterType.IsAssignableFrom(concrete))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FieldReadOnly,
                "'position' is mirrored into the placement index (which cell a reference is in, and " +
                "where) — nothing on this path re-derives that side table, so a placed reference's " +
                "position is not writable through a field edit.");
        }

        return null;
    }

    /// <summary>
    /// Moves the source unit when the edit changed the EditorID its own name carries,
    /// and answers the path to write to either way.
    ///
    /// <para><b>Move first, then write</b> — deliberately, and please do not tidy this into the other
    /// order. A crash between the two leaves the file at its new name holding its old content: valid
    /// JSON, one re-edit from correct, and still findable — because
    /// <see cref="SourceUnitResolver.FlatSourcePath"/> falls back to the FormKey suffix when the
    /// computed name is absent. The reverse order — write the new path, then delete the old — leaves
    /// two files claiming one FormKey for the duration of the window, which is the corrupt-tree state
    /// <see cref="AmbiguousSourceUnitException"/> exists to refuse.</para>
    ///
    /// <para><b>That "still findable" is load-bearing.</b> Without the fallback, a name/content
    /// divergence reads as an absent file and marks a live record deleted. The
    /// fallback is what makes this ordering recoverable — and it is not only about crashes: the same
    /// divergence arrives whenever anything edits <c>EditorID</c> inside a source file directly, which
    /// is the ordinary never-assume-exclusive-ownership case rather than an exotic one.</para>
    ///
    /// <para>Only the leaf moves. A container's directory is moved whole, so the folder-split children
    /// Spriggit does not embed (a Quest's dialog topics and scenes) travel with their parent rather
    /// than being orphaned by it.</para>
    ///
    /// <para>Nothing here tells git that a rename happened, because git has no rename tracking to
    /// tell: it infers renames from content similarity at diff time. What that actually produces is
    /// measured in tests rather than assumed here.</para>
    /// </summary>
    private string RenameSourceUnit(SourceUnit unit, IMajorRecord edited, RecordDocument document)
    {
        // An embedded child's EditorID appears in no path: the file belongs to its parent, whose own
        // EditorID this edit did not touch. Nothing to move.
        if (unit.IsEmbedded) return unit.FullPath;
        if (string.Equals(edited.EditorID, document.EditorId, StringComparison.Ordinal)) return unit.FullPath;

        var isDirectoryPerRecord = unit.IsDirectoryPerRecord;
        var oldLeafPath = isDirectoryPerRecord ? Path.GetDirectoryName(unit.FullPath)! : unit.FullPath;

        // An EditorID-only rename must not silently drop the record back to the front of its
        // siblings (LeafNameFor's own name never carries a prefix) — the old leaf's own "[N] ", if it
        // has one, rides forward onto the new name unchanged. No siblings need touching: this record's
        // slot number is exactly what it was before the rename, just spelled with a new EditorID.
        var oldLeafName = Path.GetFileName(oldLeafPath);
        var orderIndex = SourceUnitResolver.TryGetOrderIndex(oldLeafName);
        var newLeafName = SourceUnitResolver.LeafNameFor(edited.FormKey, edited.EditorID, isDirectoryPerRecord);
        if (orderIndex is { } index) newLeafName = $"[{index}] {newLeafName}";
        var newLeafPath = Path.Combine(Path.GetDirectoryName(oldLeafPath)!, newLeafName);

        if (string.Equals(oldLeafPath, newLeafPath, StringComparison.Ordinal)) return unit.FullPath;

        if (isDirectoryPerRecord)
        {
            Directory.Move(oldLeafPath, newLeafPath);
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation(
                    "EditorID changed on {FormKey}; moved its source directory {Old} to {New}",
                    edited.FormKey, Path.GetFileName(oldLeafPath), Path.GetFileName(newLeafPath));
            }
            return Path.Combine(newLeafPath, SourceUnitResolver.RecordDataFileName);
        }

        File.Move(oldLeafPath, newLeafPath, overwrite: true);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "EditorID changed on {FormKey}; moved its source file {Old} to {New}",
                edited.FormKey, Path.GetFileName(oldLeafPath), Path.GetFileName(newLeafPath));
        }
        return newLeafPath;
    }

    /// <summary>
    /// Deletes one plugin's copy of <paramref name="formKey"/> as a working-tree change — the
    /// source file goes away, and <see cref="IRecordIndex.ApplyWorkingTreeChanges"/>'s null-Body case
    /// takes it from there: gone at
    /// Effective, still served at Head until this is committed and compiled. No reference cascade —
    /// a FormLink elsewhere pointing at the deleted record goes dangling and surfaces as an ordinary
    /// compile diagnostic, exactly like any other dangling link (ADR-0041).
    ///
    /// <para>Resolution is <see cref="SourceUnitResolver"/>,
    /// the same as <see cref="EditField"/>, so a container's own record (its
    /// directory, cascading every embedded/folder-split descendant's index row), an embedded
    /// child (spliced out of its owner's inline slot, the owner rewritten) and a flat record
    /// (<see cref="SourceUnitResolver.Resolve"/>'s own flat branch <i>is</i>
    /// <see cref="SourceUnitResolver.FlatSourcePath"/>) all delete through this one method.</para>
    /// </summary>
    public RecordEditResult DeleteRecord(PluginKey plugin, string formKey)
    {
        if (ResolveEditTarget(plugin, formKey, out var target) is { } blocked) return blocked;
        // document isn't needed past this header check — every remaining branch below reads through
        // the resolved source unit instead.
        var (index, _, release, document, unit) = target;
        if (RefuseIfHeader(document.RecordType) is { } headerRefusal) return headerRefusal;
        var reads = index.At(RecordRef.Effective);

        var deltas = new List<(string FormKey, string? Body)>();

        if (unit.IsEmbedded)
        {
            var owner = reads.GetDocument(unit.OwnerFormKey, plugin)!;
            var record = ReadRecordFromSource(_codec, logger, unit.FullPath, owner, release);

            if (!ContainerChildFields.RemoveEmbeddedChild(record, formKey))
            {
                // Same "indexed but not actually there" diagnosis EditField's own embedded lookup
                // gives — states only what is observed, never guesses an external-change cause.
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    $"{unit.RelativePath} is indexed as holding {formKey}, but its own text does not " +
                    "carry it. If nothing outside Modbench changed that file, this is a defect — please " +
                    "report it; otherwise relaunch mEdit so the index re-reads the tree.");
            }

            deltas.Add((unit.OwnerFormKey, SerializeAndWrite(_codec, record, unit.FullPath, release)));
        }
        else
        {
            // A folder-split child's container_child.SlotIndex mirrors its own "[N]" file-name
            // prefix — captured before anything moves, so the survivors' new positions can be
            // computed the same way RenormalizeGroupOrder computes them on disk below (sort by old
            // rank ascending, assign 0..k-1). Null for a top-level container/flat record, which is
            // nobody's folder-split child.
            var parentLink = reads.GetContainerParent(plugin, formKey);

            // A container's own directory (Cell/Worldspace/Quest, or a nested folder-split child —
            // DialogTopic etc.), or a flat record's single file. Never-assume-exclusive-ownership: the
            // unit may already be gone (another tool, a hand delete) — that is exactly the working-tree
            // state this call is trying to reach, not a failure to report.
            var groupDirectory = unit.IsDirectoryPerRecord
                ? Path.GetDirectoryName(Path.GetDirectoryName(unit.FullPath)!)!
                : Path.GetDirectoryName(unit.FullPath)!;

            if (unit.IsDirectoryPerRecord)
            {
                var directory = Path.GetDirectoryName(unit.FullPath)!;
                if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
            }
            else if (File.Exists(unit.FullPath))
            {
                File.Delete(unit.FullPath);
            }

            // The delete's own last file-system act — closes whatever "[N]" gap it just left in
            // the touched group directory, so the source tree's own working invariant (every group
            // directory contiguous, SourceUnitResolver's own doc comment) holds again before this
            // returns, rather than merely being restorable by a later re-Track.
            SourceUnitResolver.RenormalizeGroupOrder(groupDirectory);

            // container_child's own copy of that same renumbering — the deleted child's row
            // disappears for free (it is simply not among the survivors passed in), and every
            // surviving sibling's SlotIndex lands exactly where a fresh ingest of the renormalized
            // tree would put it.
            if (parentLink is { } parent)
            {
                var survivors = reads.GetContainerChildren(plugin, parent.ParentFormKey)
                    .Where(c => c.SlotName == parent.SlotName && c.ChildFormKey != formKey)
                    .OrderBy(c => c.SlotIndex)
                    .Select((c, i) => (c.ChildFormKey, SlotIndex: i))
                    .ToList();
                index.ReplaceContainerChildSlot(
                    plugin, parent.ParentFormKey, parent.ParentRecordType, parent.SlotName, survivors);
            }
        }

        // Both shapes cascade the same way: a container's own delete removes its directory whole (a
        // Cell's placed refs/navmesh/landscape inline, a Quest's DialogTopics/Scenes/Branches nested
        // beneath it on disk), and an embedded child's own delete can itself have descendants two
        // levels deep (a Worldspace's TopCell carrying its own placed refs). Every descendant's index
        // row is nulled alongside the target's own, in the one batch below.
        deltas.Add((formKey, null));
        foreach (var descendant in EnumerateDescendantFormKeys(reads, plugin, formKey))
            deltas.Add((descendant, null));

        index.ApplyWorkingTreeChanges(plugin, deltas);
        // A deleted row can no longer match an active filter.
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Deleted {FormKey} from {Plugin} ({Origin}) — working-tree deletion of {SourcePath} ({Count} index row(s) removed)",
                formKey, plugin.Name, plugin.Origin, unit.RelativePath, deltas.Count);
        }
        return RecordEditResult.Success();
    }

    /// <summary>
    /// Every descendant <paramref name="formKey"/> holds, recursively — a Cell's placed refs
    /// (<see cref="IRecordReads.GetCellReferences"/>), a Worldspace's TopCell
    /// (<see cref="IRecordReads.GetWorldspaceCells"/>, every row with no block coordinates —
    /// normally exactly one, but the cascade can't assume that, the same reason
    /// <see cref="Queries.WorldspaceQueryService.GetWorldspaceBlocks"/> can't either) and
    /// whatever <see cref="IRecordReads.GetContainerChildren"/> names (navmesh/landscape, a Quest's
    /// dialog branches/topics/scenes, a DialogTopic's responses) — so a container's own delete can
    /// null every descendant's index row in the same batch as its own.
    ///
    /// <para>Deliberately index-derived, not object-graph-derived: <see cref="ContainerChildFields.EnumerateChildren"/>
    /// walks a <i>deserialized</i> record, and the per-record codec never populates a folder-split
    /// child (a Quest's DialogTopics) onto the parent it reads — only the whole-mod door does that.
    /// The index's own side tables, populated at ingest from that same whole-mod walk, are what still
    /// know the relationship. Harmless to call for a childless or non-container FormKey: every one of
    /// the three reads below simply answers empty, so no caller needs to know the shape in advance
    /// (<see cref="DeleteRecord"/> calls this unconditionally).</para>
    /// </summary>
    private static IEnumerable<string> EnumerateDescendantFormKeys(IRecordReads reads, PluginKey plugin, string formKey)
    {
        var refs = reads.GetCellReferences(plugin, formKey);
        var placedDescendants = refs.Persistent.Concat(refs.Temporary)
            .SelectMany(placed => WithDescendants(reads, plugin, placed.FormKey));

        // Every block-less cell-location row, not just the first — the same shape
        // WorldspaceQueryService.GetWorldspaceBlocks guards against. A
        // worldspace is only ever supposed to carry one such row (its TopCell), but the data can't
        // rule out a second, and a delete cascade that silently stops at the first would orphan the
        // second row's own descendants rather than merely mislabeling them.
        var topCellDescendants = reads.GetWorldspaceCells(plugin, formKey)
            .Where(c => c.BlockX == null)
            .SelectMany(topCell => WithDescendants(reads, plugin, topCell.FormKey));

        var childDescendants = reads.GetContainerChildren(plugin, formKey)
            .SelectMany(child => WithDescendants(reads, plugin, child.ChildFormKey));

        return placedDescendants.Concat(topCellDescendants).Concat(childDescendants);
    }

    /// <summary><paramref name="formKey"/> itself, followed by everything <b>it</b> descends to — the
    /// per-child recursive step <see cref="EnumerateDescendantFormKeys"/>'s three
    /// <c>SelectMany</c>/ternary branches all need identically (a Worldspace's TopCell is itself a Cell
    /// with its own placed refs, e.g.), factored out once rather than repeated per branch.</summary>
    private static IEnumerable<string> WithDescendants(IRecordReads reads, PluginKey plugin, string formKey) =>
        new[] { formKey }.Concat(EnumerateDescendantFormKeys(reads, plugin, formKey));

    /// <summary>
    /// Mints a brand-new record — the create half of a lifecycle gesture. The FormKey is either
    /// <paramref name="requestedFormKey"/> (xEdit's typed-FormID path) or, when null, the next free
    /// local FormID under the plugin's own ModKey, collision-checked against both
    /// <see cref="RecordRef.Effective"/> and <see cref="RecordRef.Head"/> so an uncompiled prior
    /// create or a working-tree-deleted record can never be handed out twice.
    /// </summary>
    public RecordEditResult CreateRecord(PluginKey plugin, string recordType, string? editorId, string? requestedFormKey = null)
    {
        if (RefuseIfBlocked(plugin, out var modFolder) is { } blocked) return blocked;

        var index = mirror.Index;
        if (index == null)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No load order has been received.");

        var release = mirror.LoadOrder!.GameRelease;
        var schemas = schemaReflector.GetSchemas(release);
        if (recordType == HeaderIndexer.RecordType || !schemas.TryGetValue(recordType, out var schema))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordTypeNotFound, $"'{recordType}' is not a creatable record type.");
        }
        if (RefuseIfContainerType(recordType, release) is { } containerRefusal) return containerRefusal;

        if (ResolveTargetFormKey(index, plugin, requestedFormKey, out var targetFormKey) is { } refusedTarget) return refusedTarget;

        // Mutagen's own generic-across-games factory (Mutagen.Bethesda.Plugins.Utility) — every
        // generated major-record type's (FormKey, GameRelease) constructor is declared private
        // precisely so this is the supported way to reach it, rather than a hand-rolled reflection
        // bypass over Mutagen's own generated code.
        var record = MajorRecordInstantiator.Activator(FormKey.Factory(targetFormKey), release, schema.RecordType);
        if (!string.IsNullOrWhiteSpace(editorId)) record.EditorID = editorId;

        // A brand-new sibling goes at the end of its group folder, one past whatever "[N] " is
        // already the highest there (0 for a plugin's first record of this type).
        // RefuseIfContainerType above already guarantees FolderNameFor is non-null for recordType.
        var orderIndex = SourceUnitResolver.NextOrderIndexFor(modFolder, plugin.Name, recordType, release);

        var relativePath = SourceRecordPath.For(plugin.Name, recordType, targetFormKey, record.EditorID, release, orderIndex);
        var sourcePath = Path.Combine(modFolder, relativePath);

        // Track's eager serialization only created directories for (record type, origin ModKey)
        // combinations the plugin already held — a genuinely new one (the first Weapon a plugin ever
        // held, say) needs its own. The codec deliberately leaves directory-creation policy to its
        // caller (RecordTextCodec.SerializeAsync's own doc comment).
        Directory.CreateDirectory(Path.GetDirectoryName(sourcePath)!);

        var newBody = SerializeAndWrite(_codec, record, sourcePath, release);

        // Defensive, not merely a repeat of the invariant NextOrderIndexFor above already
        // upholds — never-assume-exclusive-ownership means this group folder can already hold a gap
        // nothing here caused (a hand-deleted sibling, another tool's edit), and this closes it as part
        // of the same write rather than leaving it for the next structural write to trip over.
        SourceUnitResolver.RenormalizeGroupOrder(Path.GetDirectoryName(sourcePath)!);

        index.CreateWorkingTreeRecord(plugin, targetFormKey, recordType, newBody);
        // A brand-new row can newly match an active filter.
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Created {RecordType} {FormKey} in {Plugin} ({Origin}) — new working-tree source file at {SourcePath}",
                recordType, targetFormKey, plugin.Name, plugin.Origin, relativePath);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    /// <summary>
    /// xEdit's "Copy as Override Into…" (ADR-0041) — <paramref name="formKey"/>'s
    /// bytes, landing under the <b>same</b> FormKey in <paramref name="destinationPlugin"/>'s own
    /// working tree. Needs no Mutagen deserialization at all: <see cref="RecordDocument.Body"/> is
    /// byte-identical to the source file (its own doc-comment guarantee), so the seed text goes
    /// straight from wherever it is read to the destination's <see cref="SourceRecordPath"/>,
    /// verbatim. The destination's master dependency on the record's origin is derived at compile
    /// from whatever FormLinks/origin the bytes carry (ADR-0038) — no copy-specific master handling
    /// here, deliberately.
    ///
    /// <para>Seed reading follows <see cref="EditField"/>'s own read posture (<see cref="ReadCopySourceBody"/>):
    /// a tracked <paramref name="sourcePlugin"/> reads its current source file; an untracked one — the
    /// common case, a Data-directory master such as Fallout4.esm — has no working tree to read from,
    /// so the indexed document body is the only representation that exists for it.</para>
    /// </summary>
    public RecordEditResult CopyRecordAsOverride(PluginKey sourcePlugin, string formKey, PluginKey destinationPlugin)
    {
        if (ResolveCopySource(destinationPlugin, sourcePlugin, formKey, out var source) is { } blocked) return blocked;
        var (index, destinationModFolder, release, document) = source;
        if (RefuseIfUnderride(formKey, destinationPlugin) is { } underrideRefusal) return underrideRefusal;
        var reads = index.At(RecordRef.Effective);

        // A placed reference (a Cell's Persistent/Temporary child) has its own,
        // parent-chain-aware handling — it never reaches RefuseIfCopySourceHasNoContainerOfItsOwn's
        // blanket refusal below at all. GetPlacement answering is exactly what distinguishes "a placed
        // reference" from every other embedded/folder-split type that predicate still refuses
        // (Landscape, NavigationMesh, DialogTopic, Scene).
        if (RecordTypeDispatch.For(release).GroupFolderNameFor(document.RecordType) is null
            && reads.GetPlacement(formKey, sourcePlugin) is { } placement)
        {
            return _recordCopy.CopyPlacedReferenceAsOverride(
                sourcePlugin, formKey, document, placement, destinationPlugin, destinationModFolder, index, release);
        }

        if (RefuseIfCopySourceHasNoContainerOfItsOwn(document.RecordType, release) is { } containerRefusal) return containerRefusal;

        var isFlat = RecordTypeDispatch.For(release).FolderNameFor(document.RecordType) is not null;
        if (!IsFreeAtBothRefs(index, destinationPlugin, formKey))
        {
            // #550 AC7: for the container-copy family, a destination that already overrides the
            // explicitly-selected record gets it replaced, own-fields-only, never refused — xEdit's
            // copy-into behavior. Flat records keep #436's refusal, deliberately; so does a record
            // held only at Head (deleted in the working tree — nothing at Effective to replace).
            if (!isFlat && reads.GetDocument(formKey, destinationPlugin) is { } existingTarget)
            {
                return ReplaceExplicitContainerCopyTarget(
                    index, sourcePlugin, formKey, document, existingTarget, destinationPlugin, destinationModFolder, release);
            }
            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{formKey} is already held by a record in {destinationPlugin.Name} at some ref.");
        }

        // IsInterior does double duty here — it is false both for a genuine
        // exterior SubCells cell (real block/sub/grid coordinates once placed) and for a Worldspace's
        // own TopCell (PlacementWalker.WalkWorldspace hardcodes isInterior: false for it, even though
        // TopCell carries no block/sub/grid either — the same "no coordinates to compute" property that
        // justifies interior auto-create). Only the genuine-SubCells-cell case mints (it has
        // a real CellLocationRow with block/sub/grid to mint from); a TopCell's own cell_location row
        // carries none of those (WalkWorldspace's own hardcoded nulls), so it falls through to the
        // refusal below — TopCell's own spatial placement is a WRLD-scale follow-up, tracked
        // separately.
        var isCell = RecordTypeDispatch.For(release).ConcreteFor(document.RecordType)?.Name == "Cell";
        var cellLocation = isCell ? reads.GetCellLocation(sourcePlugin, formKey) : null;
        if (isCell && cellLocation?.IsInterior == false && cellLocation.Value.BlockX != null)
        {
            var cellRecord = ReadCopySourceRecord(sourcePlugin, formKey, document, release);
            ContainerChildFields.ClearAllChildSlots(cellRecord);
            var mintResult = _recordCopy.MintExteriorCell(
                sourcePlugin, formKey, cellLocation.Value, cellRecord, destinationPlugin, destinationModFolder, index, release);
            if (mintResult.Applied && logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation(
                    "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into " +
                    "{DestinationPlugin} ({DestinationOrigin}) — minted its worldspace as a Partial Form ancestor",
                    formKey, sourcePlugin.Name, sourcePlugin.Origin, destinationPlugin.Name, destinationPlugin.Origin);
            }
            return mintResult;
        }
        if (isCell && cellLocation?.IsInterior != true)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.ContainerParentMissingInDestination,
                $"{formKey} is an exterior cell — copying it as override needs spatial placement " +
                "(worldspace block/sub-block) this write path does not compute yet, tracked separately.");
        }

        var body = ReadCopySourceBody(sourcePlugin, formKey, document, release);

        // A flat type keeps CreateRecord's own shape (next order index in the destination's own
        // group folder, a brand-new file there). A directory-per-record container's own top-level
        // record needs its own RecordData.json directory instead — an interior Cell nests two GRUP
        // levels deeper than Worldspace/Quest do (InteriorCellDestinationPath's own doc comment), which
        // is why it is not just another call to ContainerOwnDirectoryPath.
        string relativePath;
        if (isFlat)
        {
            var orderIndex = SourceUnitResolver.NextOrderIndexFor(destinationModFolder, destinationPlugin.Name, document.RecordType, release);
            relativePath = SourceRecordPath.For(destinationPlugin.Name, document.RecordType, formKey, document.EditorId, release, orderIndex);
        }
        else
        {
            // A plain Copy as Override is own-fields-only for every record type — for a
            // container whose document embeds its own children inline (Cell, Worldspace) that means
            // stripping them here, rather than the verbatim-bytes fast path a flat record keeps. A
            // no-op in practice for Quest (its folder-split children were never inlined to begin with).
            body = StripEmbeddedChildrenForShallowCopy(body, document.RecordType, release);
            relativePath = isCell
                ? InteriorCellDestinationPath(destinationModFolder, destinationPlugin.Name, formKey, document.EditorId, release)
                : ContainerOwnDirectoryPath(destinationModFolder, destinationPlugin.Name, document.RecordType, formKey, document.EditorId, release);
        }
        var sourcePath = Path.Combine(destinationModFolder, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(sourcePath)!);

        WriteBodyAtomic(sourcePath, body);

        SourceUnitResolver.RenormalizeGroupOrder(Path.GetDirectoryName(sourcePath)!);

        index.CreateWorkingTreeRecord(destinationPlugin, formKey, document.RecordType, body);
        // A brand-new row can newly match an active filter.
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — new working-tree source file at {SourcePath}",
                formKey, sourcePlugin.Name, sourcePlugin.Origin, destinationPlugin.Name, destinationPlugin.Origin, relativePath);
        }
        // NewFormKey is for a gesture that mints or suggests a FormKey the caller didn't already
        // have (RecordEditResult's own doc comment) — an override echoes the caller's own FormKey
        // back, same shape as DeleteRecord's "success, nothing new" below.
        return RecordEditResult.Success();
    }

    /// <summary>
    /// xEdit's "Copy as New Record Into…" (ADR-0041) — a deep copy of
    /// <paramref name="formKey"/> under a fresh FormKey in <paramref name="destinationPlugin"/>'s own
    /// working tree, via Mutagen's own record-level <c>Duplicate</c> (no mod object — nothing in this
    /// feature constructs a Mutagen plugin). <paramref name="requestedFormKey"/> and the auto-allocated
    /// fallback share <see cref="CreateRecord"/>'s own <see cref="ResolveTargetFormKey"/> resolution,
    /// so the collision posture (checked against both <see cref="RecordRef.Effective"/> and
    /// <see cref="RecordRef.Head"/>) is identical rather than re-implemented.
    ///
    /// <para>A FormLink from the record to itself is remapped onto the new FormKey
    /// (<see cref="IFormLinkContainer.RemapLinks"/>), immediately after the duplicate — so an internal
    /// self-reference follows the copy, not the original, the same as xEdit's own duplication.</para>
    /// </summary>
    public RecordEditResult CopyRecordAsNewRecord(
        PluginKey sourcePlugin, string formKey, PluginKey destinationPlugin, string? requestedFormKey = null)
    {
        if (ResolveCopySource(destinationPlugin, sourcePlugin, formKey, out var source) is { } blocked) return blocked;
        var (index, destinationModFolder, release, document) = source;
        if (RefuseIfDisallowedForCopyAsNewRecord(document.RecordType) is { } disallowedRefusal) return disallowedRefusal;

        // The QUST/DIAL/INFO family copies as new (#550 AC5 — xEdit allows exactly these); a flat
        // record keeps its existing path below; everything else still refuses (embedded children,
        // folder-split types with no copy story: Scene, Landscape, NavigationMesh).
        var isFlat = RecordTypeDispatch.For(release).FolderNameFor(document.RecordType) is not null;
        var concreteName = RecordTypeDispatch.For(release).ConcreteFor(document.RecordType)?.Name;
        if (!isFlat && concreteName is "DialogTopic")
        {
            return CopyDialogTopicAsNewRecord(
                index, sourcePlugin, formKey, document, destinationPlugin, destinationModFolder, release, requestedFormKey);
        }
        if (!isFlat && concreteName is "DialogResponses")
        {
            return CopyDialogResponseAsNewRecord(
                index, sourcePlugin, formKey, document, destinationPlugin, destinationModFolder, release, requestedFormKey);
        }
        if (!isFlat && concreteName is not "Quest"
            && RefuseIfContainerType(document.RecordType, release) is { } containerRefusal)
        {
            return containerRefusal;
        }

        if (ResolveTargetFormKey(index, destinationPlugin, requestedFormKey, out var targetFormKey) is { } refusedTarget)
            return refusedTarget;

        var sourceRecord = ReadCopySourceRecord(sourcePlugin, formKey, document, release);
        var newRecord = sourceRecord.Duplicate(FormKey.Factory(targetFormKey));
        if (newRecord is IFormLinkContainer selfLinking)
        {
            selfLinking.RemapLinks(new Dictionary<FormKey, FormKey> { [FormKey.Factory(formKey)] = FormKey.Factory(targetFormKey) });
        }

        // A flat record is a new file at the group folder's next index; a directory-per-record
        // container (Quest) is a new RecordData.json directory there instead — same split Copy as
        // Override already makes, and like it, own-record-only: folder-split children never ride
        // along (deep copy is #551's gesture).
        string relativePath;
        if (isFlat)
        {
            var orderIndex = SourceUnitResolver.NextOrderIndexFor(destinationModFolder, destinationPlugin.Name, document.RecordType, release);
            relativePath = SourceRecordPath.For(destinationPlugin.Name, document.RecordType, targetFormKey, newRecord.EditorID, release, orderIndex);
        }
        else
        {
            relativePath = ContainerOwnDirectoryPath(
                destinationModFolder, destinationPlugin.Name, document.RecordType, targetFormKey, newRecord.EditorID, release);
        }
        var sourcePath = Path.Combine(destinationModFolder, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(sourcePath)!);

        var newBody = SerializeAndWrite(_codec, newRecord, sourcePath, release);

        // The group directory whose [N] prefixes the new leaf joined — the file's own directory for
        // a flat record, the record directory's parent for a directory-per-record one.
        SourceUnitResolver.RenormalizeGroupOrder(isFlat
            ? Path.GetDirectoryName(sourcePath)!
            : Path.GetDirectoryName(Path.GetDirectoryName(sourcePath)!)!);

        index.CreateWorkingTreeRecord(destinationPlugin, targetFormKey, document.RecordType, newBody);
        // A brand-new row can newly match an active filter.
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as new record {NewFormKey} into " +
                "{DestinationPlugin} ({DestinationOrigin}) — new working-tree source file at {SourcePath}",
                formKey, sourcePlugin.Name, sourcePlugin.Origin, targetFormKey, destinationPlugin.Name,
                destinationPlugin.Origin, relativePath);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    /// <summary>
    /// #550 AC7's replace itself: the destination's existing override of the explicitly-selected
    /// container record takes the source's own fields, and nothing else moves. The destination's
    /// embedded children (a Cell's placed refs, navmeshes, landscape) are re-attached onto the
    /// replacing record (<see cref="ContainerChildFields.TransplantChildSlots"/>) so an own-fields
    /// copy can never silently delete them; folder-split children have their own files and are
    /// untouched by construction. An EditorID difference renames the source unit the same way an
    /// EditorID edit does (<see cref="RenameSourceUnit"/> — the round-trip gate regenerates
    /// canonical names, so a stale leaf would refuse the next compile).
    /// </summary>
    private RecordEditResult ReplaceExplicitContainerCopyTarget(
        IRecordIndex index, PluginKey sourcePlugin, string formKey, RecordDocument sourceDocument,
        RecordDocument existingTarget, PluginKey destinationPlugin, string destinationModFolder, GameRelease release)
    {
        var reads = index.At(RecordRef.Effective);
        var unit = SourceUnitResolver.Resolve(
                reads, destinationPlugin, destinationModFolder, formKey,
                existingTarget.RecordType, existingTarget.EditorId, release)
            ?? throw new InvalidOperationException(
                $"{formKey} is indexed in {destinationPlugin.Name} but SourceUnitResolver cannot find its source unit.");

        var replacement = ReadCopySourceRecord(sourcePlugin, formKey, sourceDocument, release);
        ContainerChildFields.ClearAllChildSlots(replacement);
        var destinationRecord = ReadRecordFromSource(_codec, logger, unit.FullPath, existingTarget, release);
        ContainerChildFields.TransplantChildSlots(destinationRecord, replacement);

        var writePath = RenameSourceUnit(unit, replacement, existingTarget);
        var newBody = SerializeAndWrite(_codec, replacement, writePath, release);
        index.ApplyWorkingTreeChanges(destinationPlugin, [(formKey, newBody)]);
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — replaced the existing override's own fields in place",
                formKey, sourcePlugin.Name, sourcePlugin.Origin, destinationPlugin.Name, destinationPlugin.Origin);
        }
        return RecordEditResult.Success();
    }

    /// <summary>
    /// The DIAL half of Copy as New Record (#550 AC5) — the topic and each of its folder-split
    /// Responses draw fresh native FormKeys (the same <see cref="ResolveTargetFormKey"/> resolution,
    /// once per record), landing under a destination override of the topic's own parent quest:
    /// reused untouched when it exists, auto-created bare and Partial Form when it doesn't (the
    /// parent-chain recipe <see cref="RecordCopy.CreateInteriorCellParent"/> documents — its own doc
    /// comment carries the full xEdit-parity argument, not repeated here). Each copied record's
    /// self-link is remapped onto its own new FormKey; links <i>between</i> copied siblings are
    /// deliberately not (a copied response naming its sibling keeps naming the original — xEdit's
    /// own behavior, per the #440 ruling).
    /// </summary>
    private RecordEditResult CopyDialogTopicAsNewRecord(
        IRecordIndex index, PluginKey sourcePlugin, string formKey, RecordDocument document,
        PluginKey destinationPlugin, string destinationModFolder, GameRelease release, string? requestedFormKey)
    {
        var reads = index.At(RecordRef.Effective);
        var parentQuest = reads.GetContainerParent(sourcePlugin, formKey)
            ?? throw new InvalidOperationException(
                $"{sourcePlugin.Name}'s index names no parent quest for dialog topic {formKey} — " +
                "container_child resolved every other read of this record.");

        if (ResolveTargetFormKey(index, destinationPlugin, requestedFormKey, out var targetFormKey) is { } refusedTarget)
            return refusedTarget;

        // The parent quest override, found or minted — resolved to its own directory either way.
        var questDirectory = EnsureContainerAncestorDirectory(
            index, reads, sourcePlugin, parentQuest.ParentFormKey, parentQuest.ParentRecordType,
            destinationPlugin, destinationModFolder, release);
        var topicsDirectory = Path.Combine(questDirectory, parentQuest.SlotName);
        Directory.CreateDirectory(topicsDirectory);

        // The topic itself: duplicate under the fresh key, self-link remapped, its own directory at
        // the slot's next order index.
        var topicRecord = ReadCopySourceRecord(sourcePlugin, formKey, document, release)
            .Duplicate(FormKey.Factory(targetFormKey));
        if (topicRecord is IFormLinkContainer selfLinking)
        {
            selfLinking.RemapLinks(new Dictionary<FormKey, FormKey> { [FormKey.Factory(formKey)] = FormKey.Factory(targetFormKey) });
        }
        var topicDirectory = Path.Combine(
            topicsDirectory,
            $"[{SourceUnitResolver.NextOrderIndex(topicsDirectory)}] " +
                SourceUnitResolver.LeafNameFor(FormKey.Factory(targetFormKey), topicRecord.EditorID, isDirectory: true));
        Directory.CreateDirectory(topicDirectory);
        var topicBody = SerializeAndWrite(
            _codec, topicRecord, Path.Combine(topicDirectory, RecordDataFileName), release);
        index.CreateWorkingTreeRecord(destinationPlugin, targetFormKey, document.RecordType, topicBody);

        // The topic's own membership in the quest's slot: whatever children the destination quest
        // already has, plus this one at the end.
        AppendChildToSlot(
            index, reads, destinationPlugin, parentQuest.ParentFormKey, parentQuest.ParentRecordType,
            parentQuest.SlotName, targetFormKey);

        // Each response: fresh key, self-link remapped, sibling links untouched, source order kept.
        // Allocation and row-creation interleave so ResolveTargetFormKey's next-free scan always
        // sees the key the previous child just took.
        var copiedChildren = new List<(string ChildFormKey, int SlotIndex)>();
        foreach (var child in reads.GetContainerChildren(sourcePlugin, formKey).OrderBy(c => c.SlotIndex))
        {
            var childDocument = reads.GetDocument(child.ChildFormKey, sourcePlugin)
                ?? throw new InvalidOperationException(
                    $"{sourcePlugin.Name}'s index names {child.ChildFormKey} as a child of {formKey} but holds no document for it.");
            if (ResolveTargetFormKey(index, destinationPlugin, requestedFormKey: null, out var childFormKey) is { } childRefused)
                return childRefused;

            var childRecord = ReadCopySourceRecord(sourcePlugin, child.ChildFormKey, childDocument, release)
                .Duplicate(FormKey.Factory(childFormKey));
            if (childRecord is IFormLinkContainer childSelfLinking)
            {
                childSelfLinking.RemapLinks(
                    new Dictionary<FormKey, FormKey> { [FormKey.Factory(child.ChildFormKey)] = FormKey.Factory(childFormKey) });
            }

            var childSlotDirectory = Path.Combine(topicDirectory, child.SlotName);
            Directory.CreateDirectory(childSlotDirectory);
            var childPath = Path.Combine(
                childSlotDirectory,
                $"[{copiedChildren.Count}] " +
                    SourceUnitResolver.LeafNameFor(FormKey.Factory(childFormKey), childRecord.EditorID, isDirectory: false));
            var childBody = SerializeAndWrite(_codec, childRecord, childPath, release);
            index.CreateWorkingTreeRecord(destinationPlugin, childFormKey, childDocument.RecordType, childBody);
            copiedChildren.Add((childFormKey, copiedChildren.Count));
        }
        if (copiedChildren.Count > 0)
        {
            index.ReplaceContainerChildSlot(
                destinationPlugin, targetFormKey, document.RecordType, "Responses", copiedChildren);
        }

        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as new dialog topic {NewFormKey} into " +
                "{DestinationPlugin} ({DestinationOrigin}) with {ChildCount} response(s), each under a fresh FormKey",
                formKey, sourcePlugin.Name, sourcePlugin.Origin, targetFormKey, destinationPlugin.Name,
                destinationPlugin.Origin, copiedChildren.Count);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    /// <summary>
    /// The INFO half of Copy as New Record (#550 AC5) — the response draws a fresh native FormKey
    /// and lands in the destination's override of its own parent topic, with the whole missing
    /// ancestor chain (topic, and the topic's own quest) auto-created bare and Partial Form when
    /// absent — <see cref="EnsureContainerAncestorDirectory"/>'s recursion, the same silent
    /// parent-chain rule every copy gesture here follows.
    /// </summary>
    private RecordEditResult CopyDialogResponseAsNewRecord(
        IRecordIndex index, PluginKey sourcePlugin, string formKey, RecordDocument document,
        PluginKey destinationPlugin, string destinationModFolder, GameRelease release, string? requestedFormKey)
    {
        var reads = index.At(RecordRef.Effective);
        var parentTopic = reads.GetContainerParent(sourcePlugin, formKey)
            ?? throw new InvalidOperationException(
                $"{sourcePlugin.Name}'s index names no parent topic for dialog response {formKey} — " +
                "container_child resolved every other read of this record.");

        if (ResolveTargetFormKey(index, destinationPlugin, requestedFormKey, out var targetFormKey) is { } refusedTarget)
            return refusedTarget;

        var topicDirectory = EnsureContainerAncestorDirectory(
            index, reads, sourcePlugin, parentTopic.ParentFormKey, parentTopic.ParentRecordType,
            destinationPlugin, destinationModFolder, release);
        var slotDirectory = Path.Combine(topicDirectory, parentTopic.SlotName);
        Directory.CreateDirectory(slotDirectory);

        var newRecord = ReadCopySourceRecord(sourcePlugin, formKey, document, release)
            .Duplicate(FormKey.Factory(targetFormKey));
        if (newRecord is IFormLinkContainer selfLinking)
        {
            selfLinking.RemapLinks(new Dictionary<FormKey, FormKey> { [FormKey.Factory(formKey)] = FormKey.Factory(targetFormKey) });
        }

        var newPath = Path.Combine(
            slotDirectory,
            $"[{SourceUnitResolver.NextOrderIndex(slotDirectory)}] " +
                SourceUnitResolver.LeafNameFor(FormKey.Factory(targetFormKey), newRecord.EditorID, isDirectory: false));
        var newBody = SerializeAndWrite(_codec, newRecord, newPath, release);
        index.CreateWorkingTreeRecord(destinationPlugin, targetFormKey, document.RecordType, newBody);
        AppendChildToSlot(
            index, reads, destinationPlugin, parentTopic.ParentFormKey, parentTopic.ParentRecordType,
            parentTopic.SlotName, targetFormKey);

        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as new dialog response {NewFormKey} into " +
                "{DestinationPlugin} ({DestinationOrigin})",
                formKey, sourcePlugin.Name, sourcePlugin.Origin, targetFormKey, destinationPlugin.Name,
                destinationPlugin.Origin);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    /// <summary>
    /// The destination's override of a copied record's ancestor, found or minted, resolved to its
    /// own directory either way. A missing ancestor auto-creates bare and Partial Form (the recipe
    /// <see cref="RecordCopy.CreateInteriorCellParent"/> documents), recursing when the ancestor is
    /// itself folder-split — a missing DialogTopic first ensures its own quest, so an INFO copied
    /// into an empty destination builds the whole chain. Overrides keep their original FormKeys
    /// throughout; only the record the user copies draws a fresh one.
    /// </summary>
    private string EnsureContainerAncestorDirectory(
        IRecordIndex index, IRecordReads reads, PluginKey sourcePlugin, string ancestorFormKey,
        string ancestorRecordType, PluginKey destinationPlugin, string destinationModFolder, GameRelease release)
    {
        if (reads.GetDocument(ancestorFormKey, destinationPlugin) is { } existing)
        {
            var unit = SourceUnitResolver.Resolve(
                    reads, destinationPlugin, destinationModFolder, ancestorFormKey,
                    existing.RecordType, existing.EditorId, release)
                ?? throw new InvalidOperationException(
                    $"{ancestorFormKey} is indexed in {destinationPlugin.Name} but SourceUnitResolver cannot find its source unit.");
            return Path.GetDirectoryName(unit.FullPath)!;
        }

        var bare = MajorRecordInstantiator.Activator(
            FormKey.Factory(ancestorFormKey), release, schemaReflector.GetSchemas(release)[ancestorRecordType].RecordType);
        PartialFormFlag.Set(bare, true);

        string recordDataPath;
        ContainerChildRow? ownParent = null;
        if (RecordTypeDispatch.For(release).GroupFolderNameFor(ancestorRecordType) is not null)
        {
            // A top-level container (Quest): its own directory at the group folder's next index.
            recordDataPath = Path.Combine(destinationModFolder, ContainerOwnDirectoryPath(
                destinationModFolder, destinationPlugin.Name, ancestorRecordType, ancestorFormKey, editorId: null, release));
        }
        else
        {
            // A folder-split container (DialogTopic): under its own parent's slot, ensured first.
            ownParent = reads.GetContainerParent(sourcePlugin, ancestorFormKey)
                ?? throw new InvalidOperationException(
                    $"{sourcePlugin.Name}'s index names no parent for folder-split container {ancestorFormKey}.");
            var parentDirectory = EnsureContainerAncestorDirectory(
                index, reads, sourcePlugin, ownParent.Value.ParentFormKey, ownParent.Value.ParentRecordType,
                destinationPlugin, destinationModFolder, release);
            var slotDirectory = Path.Combine(parentDirectory, ownParent.Value.SlotName);
            Directory.CreateDirectory(slotDirectory);
            recordDataPath = Path.Combine(
                slotDirectory,
                $"[{SourceUnitResolver.NextOrderIndex(slotDirectory)}] " +
                    SourceUnitResolver.LeafNameFor(FormKey.Factory(ancestorFormKey), editorId: null, isDirectory: true),
                RecordDataFileName);
        }

        Directory.CreateDirectory(Path.GetDirectoryName(recordDataPath)!);
        var body = SerializeAndWrite(_codec, bare, recordDataPath, release);
        index.CreateWorkingTreeRecord(destinationPlugin, ancestorFormKey, ancestorRecordType, body);
        if (ownParent is { } parentSlot)
        {
            AppendChildToSlot(
                index, reads, destinationPlugin, parentSlot.ParentFormKey, parentSlot.ParentRecordType,
                parentSlot.SlotName, ancestorFormKey);
        }
        return Path.GetDirectoryName(recordDataPath)!;
    }

    /// <summary>One new child appended at the end of a folder-split slot's <c>container_child</c>
    /// rows — existing children keep their order, re-based contiguous, the same shape
    /// <see cref="SourceUnitResolver.RenormalizeGroupOrder"/> keeps the matching file names in.</summary>
    private static void AppendChildToSlot(
        IRecordIndex index, IRecordReads reads, PluginKey destinationPlugin,
        string parentFormKey, string parentRecordType, string slotName, string childFormKey)
    {
        var children = reads.GetContainerChildren(destinationPlugin, parentFormKey)
            .Where(c => c.SlotName.Equals(slotName, StringComparison.Ordinal))
            .OrderBy(c => c.SlotIndex)
            .Select((c, i) => (c.ChildFormKey, i))
            .ToList();
        children.Add((childFormKey, children.Count));
        index.ReplaceContainerChildSlot(destinationPlugin, parentFormKey, parentRecordType, slotName, children);
    }

    /// <summary>
    /// #550 AC6's narrow load-order gate for Copy as Override: a destination loading before the
    /// record's origin plugin cannot hold an <i>over</i>ride of it — the result would be an
    /// underride (#439's own operation, with semantics this gesture does not implement), silently
    /// beaten by the origin at runtime. Only the direction is checked; a plugin the load order does
    /// not place (no slot) passes, leaving the existing gates to answer for it.
    /// </summary>
    private RecordEditResult? RefuseIfUnderride(string formKey, PluginKey destinationPlugin)
    {
        var plugins = mirror.LoadOrder?.Plugins;
        if (plugins == null) return null;

        var originName = FormKey.Factory(formKey).ModKey.FileName.String;
        var originIndex = plugins.FirstOrDefault(
            p => p.Name.Equals(originName, StringComparison.OrdinalIgnoreCase))?.LoadOrderIndex;
        var destinationIndex = plugins.FirstOrDefault(
            p => p.Name.Equals(destinationPlugin.Name, StringComparison.OrdinalIgnoreCase)
                && p.Origin.Equals(destinationPlugin.Origin, StringComparison.Ordinal))?.LoadOrderIndex;
        if (originIndex is not { } origin || destinationIndex is not { } destination || destination >= origin)
            return null;

        return RecordEditResult.Refused(
            RecordEditRefusal.UnderrideDestination,
            $"{destinationPlugin.Name} loads before {originName}, which originates {formKey} — copying it " +
            "there would be an underride, not an override: the origin's copy would still win at runtime. " +
            "Pick a destination that loads after the origin.");
    }

    /// <summary>
    /// The batch copy door (#550 AC6/Q4): every request validated up front through the same
    /// server-side gates the single gestures use — record resolvable and destination writable
    /// (<see cref="ResolveCopySource"/>), type allowed for the gesture, load-order direction
    /// (<see cref="RefuseIfUnderride"/>) — then committed sequentially. One bad request refuses the
    /// whole batch before anything writes; a genuinely unexpected mid-commit failure stops the
    /// batch, leaving the partial landing visible in <see cref="BatchCopyOutcome.Results"/>
    /// (ADR-0026). One endpoint, one validation site — Q4's ruling against client-side
    /// pre-validation drifting from server truth.
    /// </summary>
    public BatchCopyOutcome CopyRecordsBatch(IReadOnlyList<RecordCopyRequest> requests)
    {
        foreach (var request in requests)
        {
            if (ValidateCopyRequest(request) is { } refusal)
                return new BatchCopyOutcome(false, request.FormKey, refusal, []);
        }

        var results = new List<BatchCopyItemOutcome>();
        foreach (var request in requests)
        {
            var result = request.AsNewRecord
                ? CopyRecordAsNewRecord(request.SourcePlugin, request.FormKey, request.DestinationPlugin, request.RequestedFormKey)
                : CopyRecordAsOverride(request.SourcePlugin, request.FormKey, request.DestinationPlugin);
            results.Add(new BatchCopyItemOutcome(request.FormKey, result));
            // Pre-validated, so a refusal here is a race (something changed mid-batch) — stop
            // rather than pile further writes onto a state the validation no longer describes.
            if (!result.Applied) return new BatchCopyOutcome(false, request.FormKey, result, results);
        }
        return new BatchCopyOutcome(true, null, null, results);
    }

    /// <summary>
    /// The write-free half of one copy request's gates, composed from the same predicates the
    /// single gestures run — kept in one place so the batch's pre-validation cannot drift from what
    /// <see cref="CopyRecordAsOverride"/>/<see cref="CopyRecordAsNewRecord"/> would actually refuse.
    /// Collision is deliberately not validated here: for the container family a collision is AC7's
    /// replace (not a refusal), and for copy-as-new the allocator only answers accurately at commit
    /// time, one mint after another.
    /// </summary>
    private RecordEditResult? ValidateCopyRequest(RecordCopyRequest request)
    {
        if (ResolveCopySource(request.DestinationPlugin, request.SourcePlugin, request.FormKey, out var source) is { } blocked)
            return blocked;
        var (index, _, release, document) = source;
        var dispatch = RecordTypeDispatch.For(release);
        var isFlat = dispatch.FolderNameFor(document.RecordType) is not null;

        if (request.AsNewRecord)
        {
            if (RefuseIfDisallowedForCopyAsNewRecord(document.RecordType) is { } disallowed) return disallowed;
            if (!isFlat && dispatch.ConcreteFor(document.RecordType)?.Name is not ("Quest" or "DialogTopic" or "DialogResponses")
                && RefuseIfContainerType(document.RecordType, release) is { } container)
            {
                return container;
            }
            return null;
        }

        if (RefuseIfUnderride(request.FormKey, request.DestinationPlugin) is { } underride) return underride;
        var isPlacedReference = dispatch.GroupFolderNameFor(document.RecordType) is null
            && index.At(RecordRef.Effective).GetPlacement(request.FormKey, request.SourcePlugin) != null;
        if (!isPlacedReference
            && RefuseIfCopySourceHasNoContainerOfItsOwn(document.RecordType, release) is { } noContainer)
        {
            return noContainer;
        }
        return null;
    }

    /// <summary>Copy as Override's own seed read: the record's source text, verbatim — no
    /// Mutagen deserialization, since <see cref="RecordDocument.Body"/> is already byte-identical to
    /// the source file. Mirrors <see cref="EditField"/>'s read posture for a tracked plugin (the
    /// file's current bytes, not a stale index snapshot) and falls back to the indexed body for an
    /// untracked one — the only representation that exists for it.</summary>
    private string ReadCopySourceBody(PluginKey sourcePlugin, string formKey, RecordDocument document, GameRelease release)
    {
        if (TrackedCopySourcePath(sourcePlugin, formKey, document, release) is { } fullPath)
            return File.ReadAllText(fullPath);
        return document.Body!;
    }

    /// <summary>
    /// Where a tracked copy source's own file is, or null when the indexed body is the right (or
    /// only) representation: the source plugin untracked, the record embedded in a parent's document
    /// (its own indexed body is byte-accurate; the parent's file is the wrong type to read it as),
    /// or the file missing on disk — the never-assume-exclusive-ownership case, logged the same way
    /// <see cref="ReadRecordFromSource"/> logs it. Resolution is full
    /// <see cref="SourceUnitResolver.Resolve"/>, never <see cref="SourceUnitResolver.FlatSourcePath"/>
    /// alone — a container copy source (a Quest, a folder-split Response) has no flat path and threw
    /// <see cref="NotSupportedException"/> under the old computed-path read.
    /// </summary>
    private string? TrackedCopySourcePath(PluginKey sourcePlugin, string formKey, RecordDocument document, GameRelease release)
    {
        if (ModFolders.TrackedOf(mirror.LoadOrder, sourcePlugin) is not { } sourceModFolder) return null;
        if (mirror.Reads is not { } reads) return null;

        var unit = SourceUnitResolver.Resolve(
            reads, sourcePlugin, sourceModFolder, formKey, document.RecordType, document.EditorId, release);
        if (unit is { IsEmbedded: false } own && File.Exists(own.FullPath)) return own.FullPath;
        if (unit is { IsEmbedded: true }) return null;

        logger.LogWarning(
            "Source file for {FormKey} in {SourcePlugin} is missing; copying from the indexed document instead",
            formKey, sourcePlugin.Name);
        return null;
    }

    /// <summary>Copy as New Record's own seed read: the same posture as
    /// <see cref="ReadCopySourceBody"/>, but deserialized to a Mutagen record — <c>Duplicate</c> needs
    /// an object to copy, unlike the override path.</summary>
    private IMajorRecord ReadCopySourceRecord(PluginKey sourcePlugin, string formKey, RecordDocument document, GameRelease release)
    {
        if (TrackedCopySourcePath(sourcePlugin, formKey, document, release) is { } fullPath)
            return _codec.DeserializeAsync(fullPath, release, document.RecordType).GetAwaiter().GetResult();

        return _codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body!), release, document.RecordType)
            .GetAwaiter().GetResult();
    }

    /// <summary>The same write-then-rename <see cref="RecordTextCodec.SerializeAsync"/> uses —
    /// needed here too, since Copy as Override writes text directly rather than through the codec (no
    /// Mutagen deserialization is the whole point of that path).</summary>
    private static void WriteBodyAtomic(string filePath, string body)
    {
        var tempPath = filePath + ".tmp";
        try
        {
            File.WriteAllText(tempPath, body);
            File.Move(tempPath, filePath, overwrite: true);
        }
        catch
        {
            File.Delete(tempPath);
            throw;
        }
    }

    /// <summary>
    /// A renumber is a delete+create pair in source terms (the source path embeds the FormKey)
    /// plus a reference cascade — every other tracked plugin's FormLink to <paramref name="formKey"/>
    /// has to move with it, or it goes dangling the moment the old path disappears.
    ///
    /// <para><b>Native records only.</b> An override's FormKey belongs to the plugin that originated
    /// it, not to <paramref name="plugin"/> — renumbering it would mean renumbering the record across
    /// every plugin that overrides it, which is xEdit's own override-cascade and a materially bigger
    /// operation than this gesture does. Refused, naming the originating plugin.</para>
    ///
    /// <para><b>Untracked referencer refuses the whole renumber, before any write</b> — a FormLink
    /// rewrite is a working-tree change in that plugin's own repo, and an untracked one has no
    /// working tree to write to (the same posture as every other untracked refusal here).</para>
    ///
    /// <para><b>Write order is deliberate</b>: every referencing repo first, this record's own
    /// delete+create pair last. A mid-cascade failure then leaves the old FormKey still live at
    /// Effective — the blast radius is only the referencer repos already written, each independently
    /// revertable in the Source Control panel, and the target repo (whose own rewrite is the final,
    /// single-repo step) never enters a half-renumbered state. There is no cross-repo transaction —
    /// git itself is the recovery mechanism, and the thrown message on a partial failure names every
    /// repo already written, so the user knows exactly what to review.</para>
    /// </summary>
    public RecordEditResult RenumberRecord(PluginKey plugin, string formKey, string? requestedFormKey = null)
    {
        // unit is deliberately discarded: this call is only the same existence check
        // EditField/DeleteRecord make (a container's own directory, an embedded child, or a flat
        // record's file all answer here; only "nothing on disk holds this, and the index names no
        // container that would" still refuses) — RenumberTheRecordItself/RewriteReferenceField each
        // re-resolve fresh, deliberately, rather than trusting this snapshot (their own doc comments).
        // document.RecordType is kept just long enough for the header check below — a ModHeader has
        // no ordinary FormKey lifecycle a renumber could reassign, and RenumberTheRecordItself would
        // otherwise crash trying to run it through ReadRecordFromSource's generic per-record pipeline.
        if (ResolveEditTarget(plugin, formKey, out var target) is { } blocked) return blocked;
        var (index, modFolder, release, document, _) = target;
        if (RefuseIfHeader(document.RecordType) is { } headerRefusal) return headerRefusal;

        var originatingPlugin = FormKey.Factory(formKey).ModKey.FileName.String;
        if (!originatingPlugin.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.NotNativeRecord,
                $"{formKey} is an override in {plugin.Name} — {originatingPlugin} originated it. " +
                $"Renumber it there instead.");
        }

        if (ResolveTargetFormKey(index, plugin, requestedFormKey, out var targetFormKey) is { } refusedTarget) return refusedTarget;

        // Every distinct record that references formKey, source-record-deduplicated: GetReferencedBy
        // is one row per (source record, field), and a record referencing the target through two
        // fields still only needs its source file rewritten once — the body-level replace below fixes
        // every occurrence in one write.
        var referencers = index.At(RecordRef.Effective).GetReferencedBy(formKey)
            .Select(r => (FormKey: r.FormKey, Plugin: new PluginKey(r.Plugin, r.Origin)))
            .Distinct()
            .ToList();

        var untrackedReferencers = referencers
            .Select(r => r.Plugin)
            .Distinct()
            .Where(p => ModFolders.TrackedOf(mirror.LoadOrder, p) == null)
            .Select(p => p.Name)
            .Distinct()
            .OrderBy(n => n, StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (untrackedReferencers.Count > 0)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.UntrackedReferencer,
                $"{formKey} is referenced by untracked plugin(s) {string.Join(", ", untrackedReferencers)}, " +
                "so the renumber cannot rewrite their FormLinks. Track them first, then try again.");
        }

        var writtenRepos = new List<string>();
        try
        {
            foreach (var (referencerFormKey, referencerPlugin) in referencers)
            {
                var referencerModFolder = ModFolders.TrackedOf(mirror.LoadOrder, referencerPlugin)!;
                RewriteReferenceField(index, referencerPlugin, referencerModFolder, referencerFormKey, formKey, targetFormKey, release);
                writtenRepos.Add($"{referencerPlugin.Name} ({referencerPlugin.Origin})");
            }

            RenumberTheRecordItself(index, plugin, modFolder, formKey, targetFormKey, release);
            writtenRepos.Add($"{plugin.Name} ({plugin.Origin})");
        }
        catch (Exception ex)
        {
            // Names exactly which repos already carry working-tree dirt from this partial
            // cascade — every one of them is independently reviewable and revertable in the Source
            // Control panel, which is the whole reason write order (referencers first, target last)
            // matters: nothing here is a half-renumbered *target* record, only whichever referencers
            // got as far as this exception. Deliberately unfiltered (not `when (ex is IOException or
            // UnauthorizedAccessException)`): a concurrent external change mid-cascade — another
            // process deleting a referencer between GetReferencedBy and its own rewrite, say — throws
            // RewriteReferenceField's/RenumberTheRecordItself's own InvalidOperationException, and
            // that must carry this same written-repos disclosure rather than silently losing it by
            // falling through this catch to the endpoint's *different* InvalidOperationException
            // handler ("no usable load order" — a different question entirely, and a misleading answer
            // to this one). Rethrown as IOException, always, regardless of the original exception's
            // type, so this reaches the client as the same 500 every other write-path fault does,
            // carrying this richer message instead of the bare one.
            throw new IOException(
                $"Renumbering {formKey} to {targetFormKey} failed after writing to: {string.Join(", ", writtenRepos)}. " +
                "Those repos now hold working-tree dirt from this partial renumber — review and revert " +
                $"in the Source Control panel as needed. Underlying error: {ex.Message}", ex);
        }
        finally
        {
            // On both outcomes, not just success — a mid-cascade failure still leaves whatever
            // referencer rewrites already landed (writtenRepos) durably on disk before the throw above,
            // and _filter must not stay stale for those just because the record's own rewrite is what
            // failed. Re-applied once rather than per write — cheaper and no less correct, since
            // SetFilter re-derives the full matching set regardless of how many rows moved since it was
            // last run.
            mirror.ReapplyFilter();
        }

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Renumbered {OldFormKey} to {NewFormKey} in {Plugin} ({Origin}), rewriting {Count} referencing record(s)",
                formKey, targetFormKey, plugin.Name, plugin.Origin, referencers.Count);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    /// <summary>One referencing record's source file, mechanically rewritten to point at the new
    /// FormKey — a whole-body string replace rather than a field-by-field walk, so it also reaches
    /// VMAD Object properties and condition Form parameters (never checked by the reflected-column
    /// <see cref="ValidateFormLinks"/> path, but just as real a reference here).
    ///
    /// <para>Resolution is full <see cref="SourceUnitResolver.Resolve"/>, never a flat-path
    /// assumption, so a referencer that is itself a
    /// container or an embedded child (a placed ref's own <c>Base</c> FormLink, say) rewrites
    /// cleanly. The string replace lands on whichever
    /// file actually carries the text — the referencer's own file when it isn't embedded, its owner's
    /// file when it is, since an embedded record's fields live inside the owner's document. An embedded
    /// referencer additionally re-derives its own extracted row from the mutated owner, the same
    /// two-row shape <see cref="EditField"/>'s own embedded edit uses (owner's body changed, and the
    /// child's own row must not go stale next to it).</para>
    /// </summary>
    private void RewriteReferenceField(
        IRecordIndex index, PluginKey referencerPlugin, string referencerModFolder,
        string referencerFormKey, string oldFormKey, string newFormKey, GameRelease release)
    {
        var reads = index.At(RecordRef.Effective);
        var referencerDoc = reads.GetDocument(referencerFormKey, referencerPlugin)
            ?? throw new InvalidOperationException(
                $"{referencerPlugin.Name} no longer holds {referencerFormKey} mid-renumber.");

        if (SourceUnitResolver.Resolve(
                reads, referencerPlugin, referencerModFolder, referencerFormKey, referencerDoc.RecordType,
                referencerDoc.EditorId, release)
            is not { } unit)
        {
            throw new InvalidOperationException(
                $"No source unit in {referencerPlugin.Name}'s tree holds {referencerFormKey} mid-renumber.");
        }

        var body = File.Exists(unit.FullPath) ? File.ReadAllText(unit.FullPath) : referencerDoc.Body!;
        var newBody = body.Replace(oldFormKey, newFormKey, StringComparison.Ordinal);

        File.WriteAllText(unit.FullPath, newBody);

        if (!unit.IsEmbedded)
        {
            index.ApplyWorkingTreeChanges(referencerPlugin, [(referencerFormKey, newBody)]);
            return;
        }

        var owner = ReadRecordFromSource(
            _codec, logger, unit.FullPath, reads.GetDocument(unit.OwnerFormKey, referencerPlugin)!, release);
        var child = ContainerChildFields.FindEmbeddedChild(owner, referencerFormKey)?.Child
            ?? throw new InvalidOperationException(
                $"{unit.RelativePath} no longer carries {referencerFormKey} after its own reference rewrite.");
        var childBody = Encoding.UTF8.GetString(
            _codec.SerializeToBytesAsync(child, release).GetAwaiter().GetResult());

        index.ApplyWorkingTreeChanges(
            referencerPlugin, [(unit.OwnerFormKey, newBody), (referencerFormKey, childBody)]);
    }

    /// <summary>The delete+create pair itself — re-reads the source fresh (rather than trusting the
    /// caller's earlier snapshot) so a self-reference <see cref="RewriteReferenceField"/> already
    /// rewrote above is reflected in the body this reserializes under the new FormKey. Dispatches
    /// on the target's own source unit shape, resolved fresh for the same reason.</summary>
    private void RenumberTheRecordItself(
        IRecordIndex index, PluginKey plugin, string modFolder, string oldFormKey, string newFormKey, GameRelease release)
    {
        var reads = index.At(RecordRef.Effective);
        var document = reads.GetDocument(oldFormKey, plugin)
            ?? throw new InvalidOperationException($"{plugin.Name} no longer holds {oldFormKey} mid-renumber.");
        if (SourceUnitResolver.Resolve(reads, plugin, modFolder, oldFormKey, document.RecordType, document.EditorId, release)
            is not { } unit)
        {
            throw new InvalidOperationException($"No source unit in {plugin.Name}'s tree holds {oldFormKey} mid-renumber.");
        }

        if (unit.IsEmbedded)
        {
            RenumberEmbeddedChild(index, plugin, unit, oldFormKey, newFormKey, document.RecordType, release);
            return;
        }

        var record = ReadRecordFromSource(_codec, logger, unit.FullPath, document, release);
        ((IMajorRecordInternal)record).FormKey = FormKey.Factory(newFormKey);

        // A container's own directory (Cell/Worldspace/Quest, or a nested folder-split child) versus
        // a flat record's single file — the same distinction DeleteRecord makes, both now reading
        // SourceUnit's own IsDirectoryPerRecord rather than retyping the check.
        var isDirectoryPerRecord = unit.IsDirectoryPerRecord;
        var oldLeafPath = isDirectoryPerRecord ? Path.GetDirectoryName(unit.FullPath)! : unit.FullPath;
        var parentDirectory = Path.GetDirectoryName(oldLeafPath)!;

        // EditorID does not change across a renumber — only the FormKey half of the leaf name does.
        // "A delete+create pair in source terms", taken literally: the new
        // FormKey's leaf goes at the end of the same parent directory (a fresh next index), the same
        // as an ordinary CreateRecord. The old slot's number is only ever a momentary gap —
        // the renormalize pass below closes it as this method's own last file-system act.
        var newOrderIndex = SourceUnitResolver.NextOrderIndex(parentDirectory);
        var newLeafName = $"[{newOrderIndex}] " +
            SourceUnitResolver.LeafNameFor(FormKey.Factory(newFormKey), document.EditorId, isDirectoryPerRecord);
        var newLeafPath = Path.Combine(parentDirectory, newLeafName);

        string writePath;
        if (isDirectoryPerRecord)
        {
            // Moved whole, not recreated from scratch: a container's nested folder-split children (a
            // Quest's own DialogTopics subtree) travel with it rather than being orphaned.
            Directory.Move(oldLeafPath, newLeafPath);
            writePath = Path.Combine(newLeafPath, SourceUnitResolver.RecordDataFileName);
        }
        else
        {
            Directory.CreateDirectory(parentDirectory);
            writePath = newLeafPath;
        }
        var newBody = SerializeAndWrite(_codec, record, writePath, release);

        index.CreateWorkingTreeRecord(plugin, newFormKey, document.RecordType, newBody);

        if (!isDirectoryPerRecord && File.Exists(unit.FullPath)) File.Delete(unit.FullPath);

        // This method's own last file-system act — closes the gap the old slot just left (and
        // any pre-existing one besides) so the group directory is contiguous again before this returns.
        SourceUnitResolver.RenormalizeGroupOrder(parentDirectory);

        // A folder-split container's own children (a renumbered Quest's DialogTopics, a
        // renumbered DialogTopic's Responses) keep their own FormKeys and their own files untouched —
        // only this record's own directory name changed, moved whole above — so nothing re-derives
        // their container_child rows from a reserialized document the way an embedded child's would
        // be. Re-pointed here, before the old FormKey's own rows are torn down below, so they are
        // never left orphaned even for one transaction. A no-op for a record with no folder-split
        // children of its own (every other renumbered type).
        index.RepointContainerChildParent(plugin, oldFormKey, newFormKey);

        // The one mirror gap RepointContainerChildParent leaves — a renumbered Worldspace's
        // *exterior* cells
        // (cell_location.parent_worldspace), which CreateWorkingTreeRecord's own re-derivation above
        // can never reach (ContainerChildFields cannot walk into Worldspace.SubCells at all; it only
        // ever recurses into TopCell). Positioned the same as RepointContainerChildParent, before the
        // old FormKey's rows are torn down — and safely so even though CreateWorkingTreeRecord already
        // ran above: that call's own cell_location write for TopCell deletes-then-inserts keyed by the
        // *cell's own* cell_form_key (unaffected by whichever parent_worldspace value the row currently
        // holds), so it never leaves a stale TopCell row for this UPDATE to touch — this only ever
        // matches an exterior cell's row, which CreateWorkingTreeRecord's re-derivation never reaches
        // either way. A no-op for any renumbered record other than a Worldspace.
        index.RepointCellLocationParent(plugin, oldFormKey, newFormKey);

        index.ApplyWorkingTreeChanges(plugin, [(oldFormKey, null)]);
    }

    /// <summary>
    /// The embedded half of a renumber — the child's own <c>FormKey</c> field changes in place
    /// inside its owner's object graph (no file moves: an embedded record has no leaf name of its own
    /// to carry a new identity), the owner is reserialized over its existing file, and the child's own
    /// extracted row is replaced (old FormKey's row nulled, new FormKey's row created from the child
    /// alone) — the same two-row shape <see cref="EditField"/>'s own embedded edit and
    /// <see cref="RewriteReferenceField"/>'s embedded-referencer branch both use.
    /// </summary>
    private void RenumberEmbeddedChild(
        IRecordIndex index, PluginKey plugin, SourceUnit unit, string oldFormKey, string newFormKey,
        string childRecordType, GameRelease release)
    {
        var owner = ReadRecordFromSource(
            _codec, logger, unit.FullPath, index.At(RecordRef.Effective).GetDocument(unit.OwnerFormKey, plugin)!, release);

        if (ContainerChildFields.FindEmbeddedChild(owner, oldFormKey) is not { } found)
        {
            throw new InvalidOperationException(
                $"{unit.RelativePath} is indexed as holding {oldFormKey}, but its own text does not carry it mid-renumber.");
        }

        ((IMajorRecordInternal)found.Child).FormKey = FormKey.Factory(newFormKey);

        var newOwnerBody = SerializeAndWrite(_codec, owner, unit.FullPath, release);
        var newChildBody = Encoding.UTF8.GetString(
            _codec.SerializeToBytesAsync(found.Child, release).GetAwaiter().GetResult());

        index.ApplyWorkingTreeChanges(plugin, [(unit.OwnerFormKey, newOwnerBody)]);
        index.CreateWorkingTreeRecord(plugin, newFormKey, childRecordType, newChildBody);
        index.ApplyWorkingTreeChanges(plugin, [(oldFormKey, null)]);
    }

    /// <summary>
    /// Both-refs collision-safety: <paramref name="formKey"/> must be held at neither
    /// <see cref="RecordRef.Effective"/> nor <see cref="RecordRef.Head"/> — the same rule
    /// <see cref="IRecordIndex.CreateWorkingTreeRecord"/> itself enforces (it throws rather than
    /// silently overwrite), checked here first so a collision reads as a typed refusal instead of an
    /// unhandled exception reaching the endpoint.
    /// </summary>
    internal static bool IsFreeAtBothRefs(IRecordIndex index, PluginKey plugin, string formKey) =>
        index.At(RecordRef.Effective).GetDocument(formKey, plugin) == null
        && index.At(RecordRef.Head).GetDocument(formKey, plugin) == null;

    /// <summary>
    /// The target-FormKey resolution <see cref="CreateRecord"/> and <see cref="RenumberRecord"/>
    /// both need — a caller-typed target (xEdit's own typed-FormID path: validated native to
    /// <paramref name="plugin"/>, then collision-checked at both refs) when
    /// <paramref name="requestedFormKey"/> is given, else the both-refs next-free auto-allocation.
    ///
    /// <para>Null means resolved: <paramref name="targetFormKey"/> carries the FormKey to use.
    /// Non-null is the refusal to return as-is — <paramref name="targetFormKey"/> is <c>""</c> in
    /// that case, the same "assign a harmless placeholder in the refused branch" shape
    /// <see cref="RefuseIfBlocked"/> already uses for its own <c>out</c> parameter, so this stays a
    /// plain non-nullable <see cref="string"/> rather than forcing every call site to null-check it
    /// a second time after already checking the return value.</para>
    /// </summary>
    private RecordEditResult? ResolveTargetFormKey(
        IRecordIndex index, PluginKey plugin, string? requestedFormKey, out string targetFormKey)
    {
        var mod = mirror.LoadOrder!.GetMod(plugin.Name, plugin.Origin!);

        if (requestedFormKey != null)
        {
            if (RefuseIfNotNativeTarget(requestedFormKey, plugin, mod) is { } notNative)
            {
                targetFormKey = "";
                return notNative;
            }
            if (!IsFreeAtBothRefs(index, plugin, requestedFormKey))
            {
                targetFormKey = "";
                return RecordEditResult.Refused(
                    RecordEditRefusal.FormKeyCollision,
                    $"{requestedFormKey} is already held by a record in {plugin.Name} at some ref.");
            }
            targetFormKey = requestedFormKey;
            return null;
        }

        var allocated = NextFreeNativeFormId(index, plugin, mod);
        if (allocated != null)
        {
            targetFormKey = allocated;
            return null;
        }

        targetFormKey = "";
        return RecordEditResult.Refused(
            RecordEditRefusal.FormKeySpaceExhausted, FormKeySpaceExhaustedMessage(plugin, IsLightPlugin(mod, plugin)));
    }

    /// <summary>
    /// A caller-typed target FormKey (xEdit's own typed-FormID path, on both create and
    /// renumber) must belong to <paramref name="plugin"/>'s own ModKey — the source path a native
    /// record's FormKey embeds is exactly <paramref name="plugin"/>'s own directory, so a foreign
    /// ModKey would land a record physically inside this plugin's source tree while claiming to
    /// originate somewhere else, which is indistinguishable from a corrupt override once written.
    /// xEdit's own Add/renumber gestures have no way to claim a foreign FormID either — this is not
    /// a new restriction, only this seam refusing to silently accept what the UI never offered.
    /// Reuses <see cref="RecordEditRefusal.NotNativeRecord"/>: both cases are "this operation only
    /// ever touches this plugin's own native FormKey space."
    ///
    /// <para>Once a typed target is confirmed native, it must also fit
    /// <paramref name="plugin"/>'s own addressable range — the full <c>0xFFFFFF</c> native space, or
    /// only <c>0x000</c>-<c>0xFFF</c> when <paramref name="mod"/> is ESL-flagged
    /// (<see cref="PluginFlagPredicates.IsLight"/>). Checked after ownership, not before: a FormKey
    /// belonging to a different plugin is refused for that reason regardless of its magnitude.</para>
    /// </summary>
    private static RecordEditResult? RefuseIfNotNativeTarget(string requestedFormKey, PluginKey plugin, IModGetter? mod)
    {
        var parsed = FormKey.Factory(requestedFormKey);
        var requestedOwner = parsed.ModKey.FileName.String;
        if (!requestedOwner.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.NotNativeRecord,
                $"{requestedFormKey} belongs to {requestedOwner}, not {plugin.Name} — a requested FormKey " +
                "must be native to the plugin it is being created or renumbered into.");
        }

        if (IsLightPlugin(mod, plugin) && parsed.ID > 0xFFF)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.LightPluginFormIdOutOfRange,
                $"{requestedFormKey} exceeds {plugin.Name}'s ESL local FormID range — a light-flagged " +
                "plugin can only address local FormIDs up to 0xFFF. Choose a FormID within that range, " +
                "or un-flag the plugin as ESL.");
        }

        return null;
    }

    /// <summary>
    /// The shared ESL-flagged predicate (<see cref="PluginFlagPredicates.IsLight"/>) both the
    /// typed-target range check and <see cref="NextFreeNativeFormId"/>'s cap need, bridged for the
    /// nullable <paramref name="mod"/> both callers may hold (a load order can resolve a
    /// <see cref="PluginKey"/> whose <see cref="IModGetter"/> is not loaded) — falls back to the plain
    /// extension check <see cref="PluginFlagPredicates.IsLight"/> itself would run when the header is
    /// unavailable to inspect.
    /// </summary>
    private static bool IsLightPlugin(IModGetter? mod, PluginKey plugin) =>
        mod != null
            ? PluginFlagPredicates.IsLight(mod, plugin.Name)
            : plugin.Name.EndsWith(".esl", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// The next unused local FormID under <paramref name="plugin"/>'s own ModKey — unioning the
    /// native FormKeys (<see cref="IRecordReads.GetNativeFormKeys"/>) this plugin holds at
    /// <see cref="RecordRef.Effective"/> (committed natives, plus any uncompiled prior create) and at
    /// <see cref="RecordRef.Head"/> (a native the working tree has since deleted, whose ID must still
    /// not be reused ahead of compile). Floored at the game's own recommended starting FormID
    /// (<see cref="IModGetter.GetDefaultInitialNextFormID"/>, mirroring
    /// <c>LoadOrderMirror.SafeNextFormId</c>'s identical floor) when <paramref name="mod"/> is
    /// available, else the conservative literal floor every Bethesda game shares.
    ///
    /// <para>Null means the plugin's FormKey space is exhausted — every local ID up to
    /// <c>0xFFFFFF</c> already in use, or, for a plugin <see cref="IsLightPlugin"/> reports as
    /// ESL-flagged, up to <c>0xFFF</c>: the engine cannot address a higher local ID from a
    /// light plugin's load-order slot, so this allocator can never hand one out regardless of native
    /// space still free above it. A typed refusal at both call sites
    /// (<see cref="RecordEditRefusal.FormKeySpaceExhausted"/>), not an exception: a full plugin
    /// refusing a new record is an ordinary, expected outcome, the same doctrine
    /// as every other refusal on this write path, not a fault for the caller's generic exception
    /// handling to (mis)classify as "no usable load order."</para>
    /// </summary>
    private static string? NextFreeNativeFormId(IRecordIndex index, PluginKey plugin, IModGetter? mod)
    {
        var floor = mod?.GetDefaultInitialNextFormID() ?? 0x800u;
        var highest = index.At(RecordRef.Effective).GetNativeFormKeys(plugin)
            .Concat(index.At(RecordRef.Head).GetNativeFormKeys(plugin))
            .Select(LocalId)
            .DefaultIfEmpty(0u)
            .Max();
        var next = Math.Max(floor, highest + 1);
        var cap = IsLightPlugin(mod, plugin) ? 0xFFFu : 0xFFFFFFu;
        return next > cap ? null : $"{next:X6}:{plugin.Name}";
    }

    private static string FormKeySpaceExhaustedMessage(PluginKey plugin, bool isLight) =>
        isLight
            ? $"{plugin.Name} has exhausted its ESL FormKey space — every local FormID up to 0xFFF is " +
              "already in use (a light-flagged plugin's addressable range). Un-flag it as ESL to use " +
              "the full 0xFFFFFF range."
            : $"{plugin.Name} has exhausted its FormKey space — every local FormID up to 0xFFFFFF is already in use.";

    private static uint LocalId(string formKey) =>
        uint.Parse(formKey[..formKey.IndexOf(':')], NumberStyles.HexNumber, CultureInfo.InvariantCulture);

    /// <summary>
    /// The same both-refs allocator <see cref="CreateRecord"/>/<see cref="RenumberRecord"/> use
    /// internally, exposed read-only so the Renumber gesture's FormID input box can prefill a
    /// suggested value the way xEdit's own "New FormID generated" flow does — never a write, and no
    /// tracked/untracked gate: it is pure arithmetic over already-indexed state, harmless to ask for
    /// a plugin nobody can edit yet.
    ///
    /// <para>Returns the same typed <see cref="RecordEditResult"/> shape every other entry point on
    /// this write path does, rather than a bespoke nullable-string
    /// contract — <see cref="RecordEditRefusal.RecordNotFound"/> when no load order is loaded (matching
    /// every sibling method's own "No load order is loaded." refusal here) and
    /// <see cref="RecordEditRefusal.FormKeySpaceExhausted"/> when the plugin's FormKey space is full;
    /// <see cref="RecordEditResult.NewFormKey"/> carries the suggestion on success.</para>
    /// </summary>
    public RecordEditResult PeekNextFreeFormKey(PluginKey plugin)
    {
        var index = mirror.Index;
        if (index == null)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No load order has been received.");

        var mod = mirror.LoadOrder!.GetMod(plugin.Name, plugin.Origin!);
        var formKey = NextFreeNativeFormId(index, plugin, mod);
        return formKey != null
            ? RecordEditResult.Success(formKey)
            : RecordEditResult.Refused(
                RecordEditRefusal.FormKeySpaceExhausted, FormKeySpaceExhaustedMessage(plugin, IsLightPlugin(mod, plugin)));
    }

    /// <summary>
    /// ADR-0041: Dangling and Type-Mismatched FormLinks are blocked at edit
    /// time, before anything is written. Returns the diagnostic, or null when the value is clean.
    ///
    /// <para><b>Effective state is what this resolves against</b>: a
    /// record the working tree deleted still exists at Head, and a check reading committed state
    /// would let the user point a link at something that will not be there when this compiles.
    /// Worth being precise about the mechanism, because it is not this call site's choice —
    /// <see cref="IRecordReads.Resolve"/> answers from <c>form_lookup</c>, which carries no ref
    /// dimension at all and tracks Effective at <i>both</i> refs by design (see
    /// <see cref="IRecordIndex.At"/>). So the property is enforced by
    /// <see cref="IRecordIndex.ApplyWorkingTreeChanges"/> keeping that table in step with the
    /// documents it was extracted from, not by naming a ref here; asking at Head would give the same
    /// answer, and the test that would catch a regression is the one that deletes a record's lookup
    /// row.</para>
    ///
    /// <para>The whole field is validated, not only the part that changed — the only coherent scope
    /// for a complex field that
    /// is written atomically. This walks the <i>incoming</i> value rather than the applied record so
    /// that what is checked is exactly what the caller asked to create.</para>
    ///
    /// <para>Scope is the reflected columns. VMAD Object
    /// properties and condition Form parameters carry FormKeys too and are deliberately not checked
    /// here; widening that is its own change with its own evidence.</para>
    /// </summary>
    private static string? ValidateFormLinks(
        IRecordReads reads,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        string recordType,
        string fieldPath,
        JsonElement value,
        GameRelease release)
    {
        if (!schemas.TryGetValue(recordType, out var schema)) return null;
        var col = schema.RecordColumns.FirstOrDefault(c => c.Name == fieldPath);
        if (col == null) return null;

        // The same builder the read model renders check errors from, so "what the editor flags in a
        // loaded plugin" and "what the editor refuses to create" are one definition of a broken link,
        // not two that can drift.
        return CheckErrorBuilder.Build(col.ToFieldMetadata(), value, reads.Resolve, release);
    }

    /// <summary>The Track command as the palette actually shows it — <c>package.json</c>'s title
    /// ("Track…", U+2026) under its category ("Modbench"). One constant, because a signpost naming
    /// a command the user cannot find is worse than no signpost at all.</summary>
    internal const string TrackCommandTitle = "Modbench: Track\u2026";

    /// <summary>The four things resolving an existing record for editing always answers together \u2014
    /// <see cref="ResolveEditTarget"/>'s own success shape.</summary>
    private readonly record struct EditTarget(
        IRecordIndex Index, string ModFolder, GameRelease Release, RecordDocument Document, SourceUnit Unit);

    /// <summary>
    /// The shared preamble <see cref="EditField"/>, <see cref="DeleteRecord"/> and
    /// <see cref="RenumberRecord"/>'s own existence check all restate byte-for-byte: the write-path
    /// gate (<see cref="RefuseIfBlocked"/>), the "is a load order even held" check, the record's own
    /// document at <see cref="RecordRef.Effective"/> \u2014 because that is what the user is looking at
    /// and editing from, a second edit to the same record must build on the first, not on the
    /// committed baseline \u2014 and the source unit that holds it. Each of the three refuses with the
    /// same typed reason and the same message here regardless of which is asking.
    ///
    /// <para><b>Not every verb goes through this.</b> <see cref="CreateRecord"/> has no existing
    /// document to resolve \u2014 a brand-new record has nothing to look up yet, not a restatement of this
    /// shape with a step skipped. <see cref="CopyRecordAsOverride"/>/<see cref="CopyRecordAsNewRecord"/>
    /// don't either: they gate on the <i>destination</i> plugin while reading the document from the
    /// <i>source</i> plugin, and never resolve a source unit through
    /// <see cref="SourceUnitResolver.Resolve"/> at all (their own source read falls back to the
    /// indexed body for an untracked source instead of refusing) \u2014 a genuinely asymmetric shape,
    /// covered by <see cref="ResolveCopySource"/> instead of this one.</para>
    ///
    /// <para><see cref="RenumberRecord"/>'s own call discards <see cref="EditTarget.Unit"/> after
    /// this existence check \u2014 deliberately: it re-resolves fresh later, per its own re-read-fresh
    /// doc comments, rather than trusting this snapshot.</para>
    /// </summary>
    private RecordEditResult? ResolveEditTarget(PluginKey plugin, string formKey, out EditTarget target)
    {
        target = default;

        if (RefuseIfBlocked(plugin, out var modFolder) is { } blocked) return blocked;

        var index = mirror.Index;
        if (index == null)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No load order has been received.");
        var reads = index.At(RecordRef.Effective);

        var document = reads.GetDocument(formKey, plugin);
        if (document == null)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound,
                $"{plugin.Name} does not hold record {formKey}.");
        }

        var release = mirror.LoadOrder!.GameRelease;

        // Which file holds this record. A flat record's own, a container's
        // RecordData.json, or \u2014 for an embedded child (a placed ref, a landscape, a navmesh, a
        // worldspace's top cell) \u2014 its parent container's, since the child has no file of its own.
        if (SourceUnitResolver.Resolve(reads, plugin, modFolder, formKey, document.RecordType, document.EditorId, release)
            is not { } unit)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.SourceUnitNotFound,
                $"No source file in {plugin.Name}'s tree holds {formKey}, and the index names no container " +
                "that would. Something moved or removed it outside Modbench \u2014 check the Source Control panel.");
        }

        target = new EditTarget(index, modFolder, release, document, unit);
        return null;
    }

    /// <summary>The three things <see cref="CopyRecordAsOverride"/>/<see cref="CopyRecordAsNewRecord"/>
    /// both need from their own source read, beside the destination mod folder <see cref="RefuseIfBlocked"/>
    /// already answers.</summary>
    private readonly record struct CopySource(IRecordIndex Index, string DestinationModFolder, GameRelease Release, RecordDocument Document);

    /// <summary>
    /// The copy gestures' own shared preamble \u2014 asymmetric by construction, unlike
    /// <see cref="ResolveEditTarget"/>: the write-path gate
    /// (<see cref="RefuseIfBlocked"/>) checks <paramref name="destinationPlugin"/> (that is where the
    /// write lands), while the document lookup and its "does not hold record" refusal read
    /// <paramref name="sourcePlugin"/> (that is what is being copied). Never resolves a source unit \u2014
    /// each copy gesture's own source read (<see cref="ReadCopySourceBody"/>/<see cref="ReadCopySourceRecord"/>)
    /// falls back to the indexed body for an untracked source rather than refusing, so there is no
    /// single "not found" shape to share here.
    /// </summary>
    private RecordEditResult? ResolveCopySource(
        PluginKey destinationPlugin, PluginKey sourcePlugin, string formKey, out CopySource source)
    {
        source = default;

        if (RefuseIfBlocked(destinationPlugin, out var destinationModFolder) is { } blocked) return blocked;

        var index = mirror.Index;
        if (index == null)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No load order has been received.");

        var document = index.At(RecordRef.Effective).GetDocument(formKey, sourcePlugin);
        if (document == null)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound,
                $"{sourcePlugin.Name} does not hold record {formKey}.");
        }

        var release = mirror.LoadOrder!.GameRelease;
        source = new CopySource(index, destinationModFolder, release, document);
        return null;
    }

    /// <summary>
    /// The two refusals every entry point on this single write path must inherit, in order \u2014
    /// untracked, then the external-change deferral \u2014 checked here once so
    /// <see cref="EditField"/>, <see cref="DeleteRecord"/> and <see cref="CreateRecord"/> cannot
    /// drift on either. Null means neither refusal applies, and <paramref name="modFolder"/> is the
    /// mod folder every caller needs next.
    ///
    /// <para>INVARIANT for future write gestures: every new one must enter through a method on this
    /// class that calls this helper first \u2014 never call <see cref="IRecordIndex.ApplyWorkingTreeChanges"/>
    /// or <see cref="IRecordIndex.CreateWorkingTreeRecord"/> some other way, which is exactly what
    /// <c>RecordEditServiceExternalChangeDeferralTests</c>' rival proved bypasses the deferral
    /// refusal entirely when this check is skipped.</para>
    /// </summary>
    private RecordEditResult? RefuseIfBlocked(PluginKey plugin, out string modFolder)
    {
        if (ModFolders.TrackedOf(mirror.LoadOrder, plugin) is not { } folder)
        {
            modFolder = "";
            return RefuseUntracked(plugin);
        }
        modFolder = folder;

        // A same-plugin external-change question left unanswered refuses every
        // gesture on the single write path \u2014 checked before anything else, so neither of the write
        // path's two doors fires: the source file is never touched, and the index call that would
        // tell the DB about it is never reached.
        return ExternalChangeDeferral.Unanswered(folder, plugin.Name) is { } question
            ? RecordEditResult.Refused(RecordEditRefusal.ExternalChangeUnanswered, question)
            : null;
    }

    // Two refusals, because there are two different ways out and a message that named neither
    // would be silent dead UI.
    private RecordEditResult RefuseUntracked(PluginKey plugin) =>
        ModFolders.Of(mirror.LoadOrder, plugin) is null
            ? RecordEditResult.Refused(
                RecordEditRefusal.PluginHasNoModFolder,
                $"{plugin.Name} is a base-game plugin with no mod folder, so it cannot be tracked. " +
                "Author a patch plugin and edit the override there.")
            : RecordEditResult.Refused(
                RecordEditRefusal.PluginNotTracked,
                $"{plugin.Name} is not tracked, so it is read-only. " +
                // The palette entry verbatim: package.json contributes title "Track…" under
                // category "Modbench", which VS Code renders as "Modbench: Track…". Naming a
                // command that does not exist is its own dead end, so the
                // tests assert this string exactly rather than merely containing "Track".
                $"Run \"{TrackCommandTitle}\" on it once to start editing.");

    /// <summary>
    /// <see cref="DeleteRecord"/>'s and <see cref="RenumberRecord"/>'s own header gate (#661) —
    /// both are meaningless against the header (see
    /// <see cref="RecordEditRefusal.HeaderDeleteOrRenumberNotSupported"/>'s own doc comment for why),
    /// and both must refuse <b>before</b> touching a filesystem write, the same "typed refusal before
    /// any write" invariant every other refusal on this path already holds.
    ///
    /// <para>Not folded into <see cref="ResolveEditTarget"/> itself: <see cref="EditField"/> shares
    /// that gate too, and reaches the header deliberately — it answers off the schema instead
    /// (<see cref="RefuseHeaderFieldEdit"/>), which <see cref="ResolveEditTarget"/> has no way to
    /// choose between without a verb parameter neither of its other two callers would use.</para>
    ///
    /// <para><b>Why this exists at all, concretely.</b> Without it, <c>SourceUnit.IsDirectoryPerRecord</c>
    /// — a filename-only test (<c>RecordData.json</c>) that cannot distinguish the header's own copy
    /// of that name, sitting <i>at</i> the plugin's source root, from a container's, sitting one level
    /// <i>under</i> it — answers true for the header, and <see cref="DeleteRecord"/>'s directory branch
    /// then deletes the plugin's own source root as "one record's" delete. Found in review on this
    /// exact ticket: an unguarded <c>DeleteRecord(plugin, headerFormKey)</c> returned
    /// <c>Applied: True</c> and took the fixture's unrelated NPC source file with it.
    /// <see cref="RenumberRecord"/>'s own path would instead hit an untyped throw
    /// (<see cref="ReadRecordFromSource"/> deserializing "header" through the generic per-record
    /// codec, which cannot carry a <see cref="ModHeader"/> at all) — smaller blast radius, same
    /// missing gate.</para>
    /// </summary>
    private static RecordEditResult? RefuseIfHeader(string recordType) =>
        recordType == HeaderIndexer.RecordType
            ? RecordEditResult.Refused(
                RecordEditRefusal.HeaderDeleteOrRenumberNotSupported,
                "The plugin header cannot be deleted or renumbered — it is not an ordinary record.")
            : null;

    /// <summary>
    /// The header's own field-edit gate (#661), reached from <see cref="EditField"/> once source-unit
    /// resolution stops refusing a header FormKey at <see cref="RecordEditRefusal.SourceUnitNotFound"/>.
    /// Answers exactly the question <see cref="RecordFieldWriter.TryApply"/> would — does the named
    /// column exist, does it carry a write delegate — without ever needing a <see cref="ModHeader"/>
    /// instance, which the generic <see cref="IMajorRecord"/> pipeline that question normally runs
    /// through cannot accept in the first place. Reuses <see cref="RefuseFieldOutcome"/> so a header
    /// field's refusal reads identically to every other read-only column's, rather than inventing a
    /// second wording for the same outcome.
    ///
    /// <para>No header column carries a write delegate today — <c>masters</c> by design (#335/
    /// ADR-0038), <c>author</c>/<c>flags</c> simply because giving them one is #290's work, not this
    /// ticket's (Minimal by default: a write mechanism nothing calls is scaffolding). The
    /// <see cref="ColumnSpec.Apply"/> non-null branch below is therefore unreached today — kept as a
    /// loud failure rather than a silent one, so a future column gaining a delegate is a build-time
    /// nudge to give this method (or replace it with) a real write path, not a refusal that quietly
    /// keeps lying about the field being read-only.</para>
    /// </summary>
    private static RecordEditResult RefuseHeaderFieldEdit(
        string fieldPath, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (!schemas.TryGetValue(HeaderIndexer.RecordType, out var schema))
            return RefuseFieldOutcome(FieldApplyOutcome.NotFound, fieldPath, HeaderIndexer.RecordType, schemas);

        var column = schema.RecordColumns.FirstOrDefault(c => c.Name == fieldPath);
        if (column == null)
            return RefuseFieldOutcome(FieldApplyOutcome.NotFound, fieldPath, HeaderIndexer.RecordType, schemas);

        if (column.Apply.Writer != null)
        {
            throw new NotSupportedException(
                $"Header column '{fieldPath}' now carries a write delegate, but RecordEditService has " +
                "no header write path — EditField's header branch only knows how to refuse. Build one " +
                "(#290) before giving any header column an Apply delegate.");
        }

        return RefuseFieldOutcome(FieldApplyOutcome.ReadOnly, fieldPath, HeaderIndexer.RecordType, schemas);
    }

    private static RecordEditResult RefuseFieldOutcome(
        FieldApplyOutcome outcome, string fieldPath, string recordType,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (outcome == FieldApplyOutcome.ReadOnly)
            return RecordEditResult.Refused(RecordEditRefusal.FieldReadOnly, $"'{fieldPath}' is read-only.");

        // Answered directly from the applier rather than inferred one layer up from "a rejection
        // whose value happens to be a genuine JSON array" — a well-typed element's own declined
        // sub-field value reaches exactly that shape too, which a heuristic could not tell apart
        // from an unresolved element type.
        if (outcome == FieldApplyOutcome.ListElementTypeUnresolved)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.ListElementTypeUnresolved,
                $"'{fieldPath}' has an element whose concrete type could not be determined from " +
                "its own payload — include that element's own type discriminator (e.g. " +
                "'value_type') to say which one it is.");
        }

        if (outcome == FieldApplyOutcome.ValueShapeMismatch)
        {
            var apiType = schemas.TryGetValue(recordType, out var schema)
                ? schema.RecordColumns.FirstOrDefault(c => c.Name == fieldPath)?.ApiType
                : null;

            return RecordEditResult.Refused(
                RecordEditRefusal.FieldValueShapeMismatch, ComplexFieldShapeMessage(fieldPath, apiType));
        }

        // #642: the payload named a sub-field inside this struct/array column that has no write
        // delegate — never ValueShapeMismatch's "send a value this field accepts", which would be
        // false: the shape was fine, the named sub-field just has no write door. Since #643 wired
        // nested Loqui structs into the shared struct applier this only fires for the genuinely
        // unwritable residue (condition data, primitive-element nested lists).
        if (outcome == FieldApplyOutcome.NestedFieldReadOnly)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.NestedFieldReadOnly,
                $"'{fieldPath}' contains a nested field that is not editable — that sub-field has " +
                "no write support; omit it from the payload to apply the rest.");
        }

        return RecordEditResult.Refused(RecordEditRefusal.FieldNotFound, $"'{recordType}' has no field '{fieldPath}'.");
    }

    /// <summary>
    /// Names the field and the JSON shape it takes. A complex field is written as one atomic
    /// value (CONTEXT.md), so the way out of this refusal is always the same — send the whole array or
    /// the whole struct with the one element/member changed, which is what the record editor now does
    /// for a per-element edit exactly as it always did for add/remove/move.
    /// </summary>
    private static string ComplexFieldShapeMessage(string fieldPath, string? apiType) => apiType switch
    {
        "array" => $"'{fieldPath}' is an array field: it takes the whole array as one value " +
                   "(a JSON array), not a single element.",
        "struct" => $"'{fieldPath}' is a struct field: it takes the whole struct as one value " +
                    "(a JSON object), not a single member.",
        _ => $"'{fieldPath}' did not accept a value of this JSON shape.",
    };

    /// <summary>
    /// The record has no flat source path, so <see cref="CreateRecord"/> — the one remaining
    /// structural gesture that still cannot place it — refuses. Checked before any write, at the one
    /// entry point that reaches <c>SourceRecordPath.For</c> unconditionally.
    ///
    /// <para><b><see cref="DeleteRecord"/> and <see cref="RenumberRecord"/> are not among
    /// them.</b> Both resolve through <see cref="SourceUnitResolver"/> instead — the same
    /// resolution <see cref="EditField"/> uses — because deleting or renumbering a
    /// container's own record, or an embedded child, is mechanical (move/remove a known file, or splice
    /// a known slot) the moment the record→source-unit question has an answer. Only
    /// <see cref="CreateRecord"/> refuses this shape: a brand-new record has no containment
    /// for anything to resolve <i>to</i> yet, and choosing one is a UX decision, not a mechanical
    /// one.</para>
    ///
    /// <para>Note the condition is wider than "Cell, Worldspace or Quest":
    /// <see cref="RecordTypeDispatch.FolderNameFor"/> is also null for
    /// every record with no top-level group of its own — placed references, landscapes, navmeshes,
    /// dialog topics, scenes. The message names what actually triggers it.</para>
    /// </summary>
    private static RecordEditResult? RefuseIfContainerType(string recordType, GameRelease release)
    {
        if (RecordTypeDispatch.For(release).FolderNameFor(recordType) is not null) return null;

        return RecordEditResult.Refused(
            RecordEditRefusal.ContainerRecordNotYetSupported,
            $"'{recordType}' has no source file of its own — it is a container record (Cell, Worldspace, " +
            "Quest) or a record embedded in one (a placed reference, landscape, navmesh, dialog topic, " +
            "scene). Editing its fields works, and so do deleting and renumbering it; creating one from " +
            "scratch does not yet — a brand-new record has no containment for anything to place " +
            "it into.");
    }

    /// <summary>
    /// <see cref="CopyRecordAsNewRecord"/>'s own permanent blacklist — xEdit itself
    /// refuses Copy as New Record for CELL/WRLD/LAND/NAVM/PGRD/ROAD/NAVI, in both its UI and its
    /// engine, because a fresh FormKey would leave the copy structurally homeless: a container's
    /// children only exist in a plugin that also carries the container, and duplicating the container
    /// itself under a new identity does not create a group for a copy to sit in. Only <c>cell</c>/
    /// <c>wrld</c> are checked by name here — the other five have no schema table at all
    /// (<see cref="SchemaReflector"/> does not surface Landscape/NavigationMesh etc. as record types),
    /// so a copy naming one has already refused earlier as <see cref="RecordEditRefusal.RecordNotFound"/>;
    /// listing them again here would be dead code, not a second line of defence.
    /// </summary>
    private static RecordEditResult? RefuseIfDisallowedForCopyAsNewRecord(string recordType)
    {
        if (recordType is not ("cell" or "wrld")) return null;

        return RecordEditResult.Refused(
            RecordEditRefusal.CopyAsNewRecordDisallowedForType,
            $"'{recordType}' cannot be copied as a new record — xEdit itself refuses this for container " +
            "types (CELL, WRLD, LAND, NAVM, PGRD, ROAD, NAVI), since a fresh FormKey would leave the copy " +
            "with no group to belong to. Copy as Override, instead.");
    }

    /// <summary>
    /// <see cref="CopyRecordAsOverride"/>'s own container gate — narrower than
    /// <see cref="RefuseIfContainerType"/>, which <see cref="CreateRecord"/> keeps unchanged. A
    /// container's own top-level record (Cell, Worldspace, Quest) has somewhere to land — its own
    /// directory, minted the same way any other structural write's group folder is — so only a record
    /// with no container of its own anywhere in the tree still refuses here: an embedded child (a
    /// placed reference, a landscape, a navmesh) or a folder-split child with no independent top-level
    /// existence (a dialog topic, a scene, a response). That is a different question from
    /// <see cref="CreateRecord"/>'s own reason to refuse every container type — a brand-new record has
    /// no containment for anything to resolve to yet — which is why the two gestures use
    /// different predicates rather than sharing this one.
    /// </summary>
    private static RecordEditResult? RefuseIfCopySourceHasNoContainerOfItsOwn(string recordType, GameRelease release)
    {
        if (RecordTypeDispatch.For(release).GroupFolderNameFor(recordType) is not null) return null;

        return RecordEditResult.Refused(
            RecordEditRefusal.ContainerRecordNotYetSupported,
            $"'{recordType}' has no container of its own anywhere in the tree — it is a record embedded " +
            "in a container (a placed reference, a landscape, a navmesh) or a folder-split child with no " +
            "independent top-level existence (a dialog topic, a scene, a response).");
    }

    /// <summary>
    /// The destination path for a directory-per-record container's own top-level record —
    /// Worldspace or Quest, whose directory sits directly under its own group folder with no further
    /// nesting (verified against a real Track output: <c>Worldspaces/[0] &lt;name&gt;/RecordData.json</c>).
    /// Cell is deliberately not handled here: its directory nests under an interior block/sub-block
    /// path (or an exterior worldspace one), which this simple "next index in one
    /// flat group folder" scheme does not compute.
    /// </summary>
    private static string ContainerOwnDirectoryPath(
        string modFolder, string pluginName, string recordType, string formKey, string? editorId, GameRelease release)
    {
        var groupFolder = RecordTypeDispatch.For(release).GroupFolderNameFor(recordType)
            ?? throw new InvalidOperationException(
                $"'{recordType}' has no group folder at all — RefuseIfCopySourceHasNoContainerOfItsOwn should have refused this first.");
        var groupDirectory = Path.Combine(modFolder, SourceRecordPath.RootFor(pluginName), groupFolder);
        var orderIndex = SourceUnitResolver.NextOrderIndex(groupDirectory);
        var leafName = SourceUnitResolver.LeafNameFor(FormKey.Factory(formKey), editorId, isDirectory: true);
        var fullPath = Path.Combine(groupDirectory, $"[{orderIndex}] {leafName}", RecordDataFileName);
        return Path.GetRelativePath(modFolder, fullPath);
    }

    // The whole-mod door's own directory-per-record file name — SourceRecordPath keeps its own copy of
    // this literal private, so this restates the same well-known constant rather than exposing it.
    private const string RecordDataFileName = "RecordData.json";

    /// <summary>
    /// The destination path for an interior Cell — the one directory-per-record type
    /// <see cref="ContainerOwnDirectoryPath"/> does not handle, since its own directory nests two GRUP
    /// levels deep (<c>Cells/&lt;block&gt;/&lt;sub-block&gt;/&lt;name&gt;/RecordData.json</c>, verified
    /// against a real Track output) rather than sitting directly under its group folder. Interior
    /// placement carries no gameplay meaning at all — <c>PlacementWalker.Walk</c>'s own interior branch
    /// never records a block/sub number in <c>cell_location</c> (verified by reading it: every interior
    /// cell's row carries null block/sub, the same as CONTEXT.md's own "the plugin's own single
    /// interior bucket" framing) — so this reuses whichever block/sub-block directory the destination
    /// already has (any one; the number is never meaningful), minting a fresh <c>[0] 0/[0] 0</c> pair
    /// only the first time a destination plugin gets an interior cell at all.
    /// </summary>
    internal static string InteriorCellDestinationPath(
        string modFolder, string pluginName, string formKey, string? editorId, GameRelease release)
    {
        var cellsFolder = RecordTypeDispatch.For(release).GroupFolderNameFor("cell")
            ?? throw new InvalidOperationException(
                "This game's schema has no Cell group folder — RefuseIfCopySourceHasNoContainerOfItsOwn should have refused this first.");
        var cellsDirectory = Path.Combine(modFolder, SourceRecordPath.RootFor(pluginName), cellsFolder);
        Directory.CreateDirectory(cellsDirectory);
        WriteMinimalGroupRecordDataIfMissing(cellsDirectory, groupType: null);

        var blockDirectory = FindOrMintGroupDirectory(cellsDirectory, "InteriorCellBlock");
        var subBlockDirectory = FindOrMintGroupDirectory(blockDirectory, "InteriorCellSubBlock");

        var orderIndex = SourceUnitResolver.NextOrderIndex(subBlockDirectory);
        var leafName = SourceUnitResolver.LeafNameFor(FormKey.Factory(formKey), editorId, isDirectory: true);
        var fullPath = Path.Combine(subBlockDirectory, $"[{orderIndex}] {leafName}", RecordDataFileName);
        return Path.GetRelativePath(modFolder, fullPath);
    }

    /// <summary>The first existing <c>"[N] &lt;number&gt;"</c> child directory of
    /// <paramref name="parentDirectory"/>, or a freshly-minted <c>"[0] 0"</c> one carrying
    /// <paramref name="groupType"/>'s own minimal <c>GroupRecordData.json</c> when none exists yet —
    /// interior placement's own "reuse whatever bucket already exists" rule
    /// (<see cref="InteriorCellDestinationPath"/>'s own doc comment).</summary>
    private static string FindOrMintGroupDirectory(string parentDirectory, string groupType)
    {
        var existing = Directory.EnumerateDirectories(parentDirectory)
            .FirstOrDefault(d => SourceUnitResolver.TryGetOrderIndex(Path.GetFileName(d)) is not null);
        if (existing != null) return existing;

        var directory = Path.Combine(parentDirectory, "[0] 0");
        Directory.CreateDirectory(directory);
        WriteMinimalGroupRecordDataIfMissing(directory, groupType);
        return directory;
    }

    // Matches Track's own JsonSerializer.SerializeToUtf8Bytes shape
    // (WriteIndented) — the one setting that matters for WriteMinimalGroupRecordDataIfMissing's
    // byte-exact-match contract, see its doc comment.
    private static readonly JsonSerializerOptions GroupRecordDataOptions = new() { WriteIndented = true };

    /// <summary>
    /// A GRUP's own tiny metadata file — never a "record" the codec has a schema for, so this writes
    /// the JSON directly rather than through <see cref="RecordTextCodec"/>. <paramref name="groupType"/>
    /// null writes <c>{}</c> (the top-level Cells group's own shape); otherwise
    /// <c>{"GroupType": "&lt;value&gt;"}</c> — <c>BlockNumber</c> is always omitted here because every
    /// group this method mints is numbered <c>0</c>, and a real Track output omits a
    /// <c>BlockNumber</c> of exactly <c>0</c> rather than writing the literal.
    ///
    /// <para>A real Track output pretty-prints this file (2-space indent,
    /// multi-line) through <c>System.Text.Json</c>'s own default writer — two block folders in the
    /// same tree ending up differently formatted
    /// is exactly what trips up byte-compare tooling.
    /// <see cref="GroupRecordDataOptions"/>'s <c>WriteIndented</c> is verified byte-for-byte identical
    /// to a real Track output for every shape this method actually writes (both the two-property and
    /// the empty-object case), not merely visually similar.</para>
    /// </summary>
    private static void WriteMinimalGroupRecordDataIfMissing(string directory, string? groupType)
    {
        var path = Path.Combine(directory, "GroupRecordData.json");
        if (File.Exists(path)) return;
        var bytes = groupType == null
            ? JsonSerializer.SerializeToUtf8Bytes(new { }, GroupRecordDataOptions)
            : JsonSerializer.SerializeToUtf8Bytes(new { GroupType = groupType }, GroupRecordDataOptions);
        File.WriteAllBytes(path, bytes);
    }

    /// <summary>
    /// Deserializes <paramref name="body"/>, clears every child-major slot
    /// (<see cref="ContainerChildFields.ClearAllChildSlots"/>) and reserializes — the one place a
    /// plain Copy as Override deserializes at all, since every other record type's own fields-only
    /// copy is already the verbatim bytes (nothing embedded to strip).
    /// </summary>
    private string StripEmbeddedChildrenForShallowCopy(string body, string recordType, GameRelease release)
    {
        var record = _codec.DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(body), release, recordType).GetAwaiter().GetResult();
        ContainerChildFields.ClearAllChildSlots(record);
        var stripped = _codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(stripped);
    }

    /// <summary>
    /// The record as its source text has it. Falls back to the indexed body only when the file is
    /// missing entirely — never-assume-exclusive-ownership (root CLAUDE.md): a tracked mod's source
    /// tree is complete when Track leaves it, but anything may have removed a file since, and
    /// refusing the edit would strand the user with no way to put the record back.
    /// </summary>
    internal static IMajorRecord ReadRecordFromSource(
        RecordTextCodec codec, ILogger logger, string sourcePath, RecordDocument document, GameRelease release)
    {
        // Both reads state the record's type rather than relying on the document to name it —
        // the same document either way, so the same record_type identifies it either way.
        if (File.Exists(sourcePath))
            return codec.DeserializeAsync(sourcePath, release, document.RecordType).GetAwaiter().GetResult();

        logger.LogWarning(
            "Source file {SourcePath} is missing; editing from the indexed document and rewriting it", sourcePath);
        return codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body!), release, document.RecordType)
            .GetAwaiter().GetResult();
    }

    /// <summary>
    /// The reserialize-and-write-back idiom nearly every write path here repeats: get
    /// <paramref name="record"/>'s own bytes — what the index will be told next — and write those
    /// exact same bytes to <paramref name="path"/> in one atomic move, never a second,
    /// independently-serialized copy of either. Returns the body as text, ready for whichever
    /// index-notify call the caller makes next.
    /// </summary>
    internal static string SerializeAndWrite(RecordTextCodec codec, IMajorRecord record, string path, GameRelease release)
    {
        var bytes = codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();
        codec.SerializeAsync(record, path, release).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(bytes);
    }
}
