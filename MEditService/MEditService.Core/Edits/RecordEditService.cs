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
        {
            // #290: the ESL flag's one sanctioned door — a synthetic boolean field, the same
            // pattern is_partial_form uses for record-flag bit 14. Every real header column still
            // refuses below (author/masters/flags stay read-only; full flags-array editing is a
            // follow-up, not smuggled in here).
            if (fieldPath.Equals(IsLightFieldPath, StringComparison.Ordinal))
                return EditHeaderIsLight(index, plugin, unit, formKey, value);
            return RefuseHeaderFieldEdit(fieldPath, schemas);
        }

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

        // An EditorID-only rename cannot disturb this record's position among its siblings, and needs
        // nothing done to keep it: order lives in the parent's own ordered child list (ADR-0042
        // decision 4) keyed by FormKey, which a rename does not change. Nothing else is touched —
        // not one sibling, and not the parent's document either.
        var newLeafName = SourceUnitResolver.LeafNameFor(edited.FormKey, edited.EditorID, isDirectoryPerRecord);
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
            // A folder-split child's container_child.SlotIndex mirrors its position in the parent's
            // ordered child list — captured before anything moves, so the survivors' new positions can
            // be computed the same way the list closes up below (sort by old rank ascending, assign
            // 0..k-1). Null for a top-level container/flat record, which is nobody's folder-split
            // child.
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

            // The delete's own last file-system act, and the whole point of ADR-0042 decision 4's
            // amendment: one line leaves one document. No sibling is renamed, so a mid-list delete
            // stages as exactly one deletion plus one changed parent — where the superseded numbering
            // scheme rewrote every later sibling's name to keep its prefixes contiguous.
            SourceChildOrder.RemoveByIdentity(groupDirectory, formKey);

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

        var relativePath = SourceRecordPath.For(plugin.Name, recordType, targetFormKey, record.EditorID, release);
        var sourcePath = Path.Combine(modFolder, relativePath);

        // The record's file and its entry in the parent's ordered child list are one edit across two
        // files (ADR-0042 decision 4), so they commit together or not at all — the same guarantee
        // #678/ADR-0045 gave the renumber cascade, and needed here for a sharper reason: the drift
        // rule is asymmetric, so a file no list names does not leave a cosmetic inconsistency, it
        // leaves the plugin unreadable until a re-Track. (The delete path needs no transaction for
        // the mirror-image reason: it removes the file first, so an interruption lands on the
        // tolerated side.)
        //
        // Track's eager serialization only created directories for (record type, origin ModKey)
        // combinations the plugin already held — a genuinely new one (the first Weapon a plugin ever
        // held, say) needs its own. The codec deliberately leaves directory-creation policy to its
        // caller (RecordTextCodec.SerializeAsync's own doc comment); the transaction's own Write
        // wraps InMintedDirectory, which unmints the group folder again if the serialize throws
        // (#675).
        var groupDirectory = Path.GetDirectoryName(sourcePath)!;
        var groupCarrier = SourceChildOrder.CarrierFor(groupDirectory, parentIsRecord: false);
        var groupKey = RecordTypeDispatch.For(release).FolderNameFor(recordType)!;

        var transaction = new SourceWriteTransaction();
        string newBody;
        try
        {
            string? written = null;
            transaction.Write(modFolder, sourcePath, () => written = SerializeAndWrite(_codec, record, sourcePath, release));
            newBody = written!;

            // A brand-new sibling lands at the end of its group's ordered child list — one line in one
            // document, and no sibling touched. RefuseIfContainerType above already guarantees
            // FolderNameFor is non-null for recordType. The prune alongside it is not a repeat:
            // never-assume-exclusive-ownership means this group's list can already name a sibling
            // whose file another tool or the user removed, which reads tolerate but the compile
            // round-trip gate does not, so repairing it here is what keeps the plugin's own next Save
            // & Compile working rather than leaving the author to meet it as a refusal.
            transaction.Write(modFolder, groupCarrier, () =>
            {
                SourceChildOrder.Add(groupCarrier, groupKey, targetFormKey);
                SourceChildOrder.PruneMissing(groupDirectory, groupCarrier, groupKey);
            });
        }
        catch
        {
            transaction.Rollback();
            throw;
        }

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

        if (!isFlat)
        {
            // A plain Copy as Override is own-fields-only for every record type — for a
            // container whose document embeds its own children inline (Cell, Worldspace) that means
            // stripping them here, rather than the verbatim-bytes fast path a flat record keeps. A
            // no-op in practice for Quest (its folder-split children were never inlined to begin with).
            body = StripEmbeddedChildrenForShallowCopy(body, document.RecordType, release);
        }

        // Where the record goes and which list names it, from one place — a Cell's block bucket is the
        // only thing that has to be resolved first, because it is chosen (or minted) rather than
        // derived.
        var destination = SourcePlacement.For(
            destinationPlugin.Name, document.RecordType, formKey, document.EditorId, release,
            isCell ? EnsureInteriorCellBlockPath(destinationModFolder, destinationPlugin.Name, release) : null);
        var relativePath = destination.RelativePath;
        var sourcePath = Path.Combine(destinationModFolder, relativePath);
        SourceUnitResolver.InMintedDirectory(Path.GetDirectoryName(sourcePath)!, () => WriteBodyAtomic(sourcePath, body));

        SourceChildOrder.Add(
            Path.Combine(destinationModFolder, destination.CarrierRelativePath), destination.Key, formKey);

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
        var concreteName = CopyAsNewContainerFamilyName(document.RecordType, release);
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

        // A flat record is a new file in the group folder; a directory-per-record
        // container (Quest) is a new RecordData.json directory there instead — same split Copy as
        // Override already makes, and like it, own-record-only: folder-split children never ride
        // along (deep copy is #551's gesture).
        var placement = SourcePlacement.For(
            destinationPlugin.Name, document.RecordType, targetFormKey, newRecord.EditorID, release);
        var relativePath = placement.RelativePath;
        var sourcePath = Path.Combine(destinationModFolder, relativePath);
        var newBody = SourceUnitResolver.InMintedDirectory(
            Path.GetDirectoryName(sourcePath)!, () => SerializeAndWrite(_codec, newRecord, sourcePath, release));

        SourceChildOrder.Add(
            Path.Combine(destinationModFolder, placement.CarrierRelativePath), placement.Key, targetFormKey);

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
        // Not created here: the topic's own mint below is what justifies this slot folder existing at
        // all, and Directory.CreateDirectory makes missing ancestors anyway — so the slot rides along
        // with the topic and is unminted with it if the topic's write fails (#675). Nothing between
        // here and there reads the directory, so its not existing yet costs nothing.
        var topicsDirectory = Path.Combine(questDirectory, parentQuest.SlotName);

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
            SourceUnitResolver.LeafNameFor(FormKey.Factory(targetFormKey), topicRecord.EditorID, isDirectory: true));
        SourceChildOrder.Add(
            SourceChildOrder.CarrierFor(questDirectory, parentIsRecord: true), parentQuest.SlotName, targetFormKey);
        var topicBody = SourceUnitResolver.InMintedDirectory(
            topicDirectory,
            () => SerializeAndWrite(_codec, topicRecord, Path.Combine(topicDirectory, RecordDataFileName), release));
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
            {
                // The topic (and any earlier responses) are already written — a Refused here would
                // silently leave that partial state behind a "nothing happened" shape. Refusals
                // precede writes; a fault after them is an exception carrying the disclosure, the
                // same posture RenumberRecord's own mid-cascade catch documents.
                throw new IOException(
                    $"Allocating a FormKey for copied response {child.ChildFormKey} failed after the new topic " +
                    $"{targetFormKey} (and {copiedChildren.Count} earlier response(s)) already landed in " +
                    $"{destinationPlugin.Name}'s working tree — review them in the Source Control panel. " +
                    $"Underlying refusal: {childRefused.Message}");
            }

            var childRecord = ReadCopySourceRecord(sourcePlugin, child.ChildFormKey, childDocument, release)
                .Duplicate(FormKey.Factory(childFormKey));
            if (childRecord is IFormLinkContainer childSelfLinking)
            {
                childSelfLinking.RemapLinks(
                    new Dictionary<FormKey, FormKey> { [FormKey.Factory(child.ChildFormKey)] = FormKey.Factory(childFormKey) });
            }

            var childSlotDirectory = Path.Combine(topicDirectory, child.SlotName);
            var childPath = Path.Combine(
                childSlotDirectory,
                SourceUnitResolver.LeafNameFor(FormKey.Factory(childFormKey), childRecord.EditorID, isDirectory: false));
            var childBody = SourceUnitResolver.InMintedDirectory(
                childSlotDirectory, () => SerializeAndWrite(_codec, childRecord, childPath, release));

            // Appended in source order, which is the order this loop walks — the new topic's own
            // document is what says where its responses sit, and a response file it does not name is
            // drift the next read refuses.
            SourceChildOrder.Add(
                SourceChildOrder.CarrierFor(topicDirectory, parentIsRecord: true), child.SlotName, childFormKey);
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
        // Minted by the response's own write below, not ahead of it (#675) — the same
        // ancestor-rides-along shape CopyDialogTopicAsNewRecord's slot folder takes.
        var slotDirectory = Path.Combine(topicDirectory, parentTopic.SlotName);

        var newRecord = ReadCopySourceRecord(sourcePlugin, formKey, document, release)
            .Duplicate(FormKey.Factory(targetFormKey));
        if (newRecord is IFormLinkContainer selfLinking)
        {
            selfLinking.RemapLinks(new Dictionary<FormKey, FormKey> { [FormKey.Factory(formKey)] = FormKey.Factory(targetFormKey) });
        }

        var newPath = Path.Combine(
            slotDirectory,
            SourceUnitResolver.LeafNameFor(FormKey.Factory(targetFormKey), newRecord.EditorID, isDirectory: false));
        SourceChildOrder.Add(
            SourceChildOrder.CarrierFor(topicDirectory, parentIsRecord: true), parentTopic.SlotName, targetFormKey);
        var newBody = SourceUnitResolver.InMintedDirectory(
            slotDirectory, () => SerializeAndWrite(_codec, newRecord, newPath, release));
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
            // A top-level container (Quest): its own directory in the group folder, and its own entry
            // in that group's ordered child list — a directory the list does not name is drift the
            // next read refuses outright.
            var ancestorPlacement = SourcePlacement.For(
                destinationPlugin.Name, ancestorRecordType, ancestorFormKey, editorId: null, release);
            recordDataPath = Path.Combine(destinationModFolder, ancestorPlacement.RelativePath);
            SourceChildOrder.Add(
                Path.Combine(destinationModFolder, ancestorPlacement.CarrierRelativePath),
                ancestorPlacement.Key, ancestorFormKey);
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
            // Not created here — the ancestor's own write below mints it along with the ancestor's
            // directory, so a failure there leaves neither behind (#675).
            var slotDirectory = Path.Combine(parentDirectory, ownParent.Value.SlotName);
            recordDataPath = Path.Combine(
                slotDirectory,
                SourceUnitResolver.LeafNameFor(FormKey.Factory(ancestorFormKey), editorId: null, isDirectory: true),
                RecordDataFileName);
            SourceChildOrder.Add(
                SourceChildOrder.CarrierFor(parentDirectory, parentIsRecord: true),
                ownParent.Value.SlotName, ancestorFormKey);
        }

        var body = SourceUnitResolver.InMintedDirectory(
            Path.GetDirectoryName(recordDataPath)!, () => SerializeAndWrite(_codec, bare, recordDataPath, release));
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
    /// rows — existing children keep their order, re-based contiguous, mirroring the parent
    /// document's own ordered child list (<see cref="SourceChildOrder"/>).</summary>
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

        // A FormKey carries only a ModKey (a filename), so the origin lookup is name-based by
        // nature; when the load order holds two same-named copies (ADR-0036's duplicate-filename
        // case) the winning one is the one whose records the FormKey resolves against.
        var originName = FormKey.Factory(formKey).ModKey.FileName.String;
        var sameNamed = plugins.Where(p => p.Name.Equals(originName, StringComparison.OrdinalIgnoreCase)).ToList();
        var originIndex = (sameNamed.FirstOrDefault(p => p.Winning) ?? sameNamed.FirstOrDefault())?.LoadOrderIndex;
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

    /// <summary>The one statement of which container types Copy as New Record supports (#550 AC5 —
    /// xEdit's DIAL/INFO/QUST allowance): the concrete type name when the record type is in the
    /// family, null otherwise. Used by <see cref="CopyRecordAsNewRecord"/>'s dispatch.</summary>
    private static string? CopyAsNewContainerFamilyName(string recordType, GameRelease release)
    {
        var name = RecordTypeDispatch.For(release).ConcreteFor(recordType)?.Name;
        return name is "Quest" or "DialogTopic" or "DialogResponses" ? name : null;
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
    /// <para><b>Computed whole, then written</b> (#676). The cascade runs in two phases: resolve the
    /// FormKey mapping and apply it through Mutagen's generated typed remap to produce <i>every</i>
    /// affected file's new bytes in memory, then write them. Every way the computation can fail — a
    /// record the index lists that the tree no longer holds, a referencer with no source unit, an
    /// embedded child missing from its own owner, a link the typed remap did not move — is a typed
    /// refusal returned before the first byte lands, per ADR-0041's refusals-precede-writes rule.
    /// What stays exposed mid-cascade is genuine I/O only.</para>
    ///
    /// <para><b>All-or-nothing across every tree it writes</b> (#678, ADR-0045). The genuine-I/O
    /// failure that #676 left exposed no longer leaves working-tree dirt for the author to hunt
    /// through: phase two runs through a <see cref="SourceWriteTransaction"/> holding each file's
    /// pre-image, and a failure part-way restores them in reverse order, then re-derives every
    /// affected plugin's index rows from its restored tree. The one thing it will not do is overwrite
    /// work it did not create — a file another tool or the author changed or deleted meanwhile keeps
    /// its current content and is named in the error instead. Process death is out of scope; the
    /// compile round-trip gate and re-Track remain its recovery path.</para>
    /// </summary>
    public RecordEditResult RenumberRecord(PluginKey plugin, string formKey, string? requestedFormKey = null)
    {
        // unit is deliberately discarded: this call is only the same existence check
        // EditField/DeleteRecord make (a container's own directory, an embedded child, or a flat
        // record's file all answer here; only "nothing on disk holds this, and the index names no
        // container that would" still refuses) — ComputeTargetRewrite/ComputeReferencerRewrites each
        // re-resolve fresh, deliberately, rather than trusting this snapshot (their own doc comments).
        // document.RecordType is kept just long enough for the header check below — a ModHeader has
        // no ordinary FormKey lifecycle a renumber could reassign, and ComputeTargetRewrite would
        // otherwise crash trying to run it through ReadRecordFromSource's generic per-record pipeline.
        if (ResolveEditTarget(plugin, formKey, out var target) is { } blocked) return blocked;
        var (index, modFolder, release, document, _) = target;
        if (RefuseIfHeader(document.RecordType) is { } headerRefusal) return headerRefusal;

        // Canonicalised once, here, and used for every string comparison below. The caller's
        // spelling reaches this method raw, and two of those comparisons are ordinal against text
        // that is always canonical — the exclusion predicate below (against the index's own
        // form_key) and ComputeReferencerRewrites' post-remap check (against serialized bytes). A
        // differently-cased spelling would silently turn both into no-ops: the target back in the
        // referencer list, and the remap-completeness guard never matching.
        var parsedFormKey = FormKey.Factory(formKey);
        formKey = parsedFormKey.ToString();

        var originatingPlugin = parsedFormKey.ModKey.FileName.String;
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
        // fields still only needs its source file rewritten once — one typed remap moves every link
        // in that record's graph at once.
        //
        // The target itself is excluded even when it references itself: its own new content is
        // computed by ComputeTargetRewrite, which applies the same mapping before stamping the new
        // FormKey on. Left in this list it would be read and written twice from two independent
        // in-memory graphs, and the second write would discard the first — the hazard the old
        // write-then-re-read sequencing hid.
        var referencers = index.At(RecordRef.Effective).GetReferencedBy(formKey)
            .Select(r => (FormKey: r.FormKey, Plugin: new PluginKey(r.Plugin, r.Origin)))
            .Where(r => r.FormKey != formKey || r.Plugin != plugin)
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

        // Phase one: nothing below this point touches the filesystem. Any refusal it returns is
        // returned with the tree exactly as this method found it.
        if (ComputeReferencerRewrites(index, formKey, targetFormKey, release, referencers, out var rewrites)
            is { } refusedReferencer) return refusedReferencer;
        if (ComputeTargetRewrite(index, plugin, modFolder, formKey, targetFormKey, release, out var targetRewrite)
            is { } refusedSelf) return refusedSelf;

        // Phase two. Everything that can still fail here is genuine I/O — and all of it is
        // recorded in one transaction, so a failure part-way puts every source tree back (#678, ADR-0045).
        var transaction = new SourceWriteTransaction();
        try
        {
            foreach (var rewrite in rewrites) WriteComputedRewrite(index, transaction, rewrite, release);
            WriteTargetRewrite(index, transaction, plugin, modFolder, targetRewrite, formKey, targetFormKey, release);
        }
        catch (Exception ex)
        {
            // Deliberately unfiltered rather than `when (ex is IOException or
            // UnauthorizedAccessException)`, so an unexpected fault is rolled back and disclosed too
            // rather than falling through to the endpoint's *different* InvalidOperationException
            // handler ("no usable load order" — a different question entirely, and a misleading answer
            // to this one). Rethrown as IOException, always, regardless of the original exception's
            // type, so this reaches the client as the same 500 every other write-path fault does.
            throw new IOException(RollBackFailedRenumber(transaction, plugin, rewrites, formKey, targetFormKey, ex), ex);
        }
        finally
        {
            // On both outcomes, not just success. On the failure path the rollback has just put the
            // files back and the affected plugins have been re-derived from them, and _filter must not
            // stay stale across either. Re-applied once rather than per write — cheaper and no less
            // correct, since SetFilter re-derives the full matching set regardless of how many rows
            // moved since it was last run.
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

    /// <summary>
    /// The failure half of the renumber: put every source tree back, re-derive the index from what
    /// the trees now hold, and compose the message the author sees (#678, ADR-0045).
    ///
    /// <para><b>The index is re-derived, not unwound.</b> It is a cache over the source trees
    /// (CONTEXT.md, Index), so the honest repair after the files go back is to read them again —
    /// <see cref="ILoadOrderMirror.ReingestPluginFromSource"/>, the same door #672 built for exactly
    /// this shape of recovery. Unwinding rows one by one would be a second, divergeable
    /// implementation of what a re-ingest already computes.</para>
    ///
    /// <para><b>Paths are named relative to the mod folder</b> — the form the Source Control panel
    /// lists them in, and the form that carries the plugin's own folder inside it, so two plugins'
    /// files can never read as the same name. The absolute paths go to the log only.</para>
    /// </summary>
    private string RollBackFailedRenumber(
        SourceWriteTransaction transaction, PluginKey plugin, IReadOnlyList<ComputedRewrite> rewrites,
        string oldFormKey, string newFormKey, Exception cause)
    {
        var unrestored = transaction.Rollback();
        if (unrestored.Count > 0)
        {
            logger.LogWarning(
                "Rolling back the failed renumber of {OldFormKey} left {Count} path(s) as they stood: {Paths}",
                oldFormKey, unrestored.Count,
                string.Join("; ", unrestored.Select(u => $"{u.FullPath} [{u.Reason}{(u.Error is null ? "" : $": {u.Error}")}]")));
        }

        var notReDerived = new List<string>();
        foreach (var affected in rewrites.Select(r => r.Plugin).Append(plugin).Distinct())
        {
            try
            {
                mirror.ReingestPluginFromSource(affected);
            }
            catch (Exception ex)
            {
                // Already recorded in the load order's own LoadFailures by the re-ingest itself
                // (ADR-0026); named here too because this message is the one the failed gesture
                // returns, and "the files went back but the index did not follow" is part of it.
                logger.LogWarning(ex, "Could not re-derive {Plugin} after rolling back a failed renumber", affected.Name);
                notReDerived.Add(affected.Name);
            }
        }

        var sentences = new List<string>
        {
            $"Renumbering {oldFormKey} to {newFormKey} failed.",
            unrestored.Count == 0
                ? "Every source tree it had written is back as it was — nothing to review or revert."
                : "Every source tree it had written is back as it was, except:",
        };

        sentences.AddRange(new[]
        {
            (UnrestoredReason.ChangedByAnother,
                "changed by something else after this renumber wrote them, so their current content was kept"),
            (UnrestoredReason.RemovedByAnother,
                "removed by something else after this renumber wrote them, so they were not put back"),
            (UnrestoredReason.OccupiedByAnother,
                "occupied by something else, so what this renumber moved away was not moved back"),
            (UnrestoredReason.RestoreFailed, "could not be restored"),
        }.Select(r => NamedPaths(unrestored, r.Item1, r.Item2)).OfType<string>());

        if (notReDerived.Count > 0)
        {
            sentences.Add(
                $"The index could not be re-read from the source of {string.Join(", ", notReDerived)} — " +
                "reindex or re-Track before editing further.");
        }

        var modFolders = rewrites.Select(r => r.ModFolder).Append(ModFolders.Of(mirror.LoadOrder, plugin))
            .OfType<string>().Distinct().ToList();
        sentences.Add($"Underlying error: {RelativeToModFolders(cause.Message, modFolders)}");
        return string.Join(" ", sentences);
    }

    /// <summary>
    /// The underlying fault's own message, with every affected mod folder's absolute path cut back to
    /// the same mod-folder-relative form the rest of this message uses. A real filesystem fault names
    /// the path it failed on — <c>Access to the path '/…/mods/Foo/source/Foo.esp/Races/[0] x.json' is
    /// denied</c> — and that is exactly the absolute path #678 says goes to the log only. The cause is
    /// still worth showing (it is the only thing that says <i>why</i>), so it is relativized rather
    /// than dropped, and the log keeps the untouched original.
    ///
    /// <para>Textual, and deliberately so: an exception message is prose, not structure, and there is
    /// no typed path to reach for. A folder this renumber never touched is not stripped — which is
    /// correct, since a path outside every affected tree is not one this message is claiming to name
    /// relatively.</para>
    /// </summary>
    private static string RelativeToModFolders(string message, IReadOnlyList<string> modFolders) =>
        modFolders
            .OrderByDescending(f => f.Length)
            .Aggregate(message, (text, folder) => text.Replace(folder + Path.DirectorySeparatorChar, "", StringComparison.Ordinal));

    private static string? NamedPaths(
        IReadOnlyList<UnrestoredPath> unrestored, UnrestoredReason reason, string phrase)
    {
        var named = unrestored.Where(u => u.Reason == reason).Select(u => u.RelativePath).ToList();
        return named.Count == 0 ? null : $"{string.Join(", ", named)} — {phrase}.";
    }

    /// <summary>One source file the cascade will rewrite, computed in full before any write: the
    /// remapped record graph, the exact bytes it serializes to, and the index rows to be re-derived
    /// from them. <paramref name="Record"/> is the file's own top-level record — the referencer
    /// itself when it is not embedded, its owner when it is, since an embedded record's fields live
    /// inside the owner's document.</summary>
    private sealed record ComputedRewrite(
        PluginKey Plugin,
        string ModFolder,
        string FilePath,
        IMajorRecord Record,
        IReadOnlyList<(string FormKey, string? Body)> IndexChanges);

    /// <summary>
    /// Phase one of the cascade for every referencing record: resolve each one's source unit,
    /// apply the FormKey mapping through Mutagen's generated typed <c>RemapLinks</c>, and serialize
    /// the result — all in memory. Returns a typed refusal on the first computation that fails, with
    /// nothing written; <c>null</c> means <paramref name="rewrites"/> carries the whole write set.
    ///
    /// <para>Referencers are grouped by the file they land in before anything is read, so a
    /// container document holding several referencing records (two placed refs in one cell, a cell
    /// and one of its own children) is read, remapped and serialized <i>once</i>. Reading it per
    /// referencer would give each one an independent graph, and the last write would discard every
    /// earlier one — a hazard the old write-one-then-re-read-the-next sequencing concealed.</para>
    ///
    /// <para><b>Why the typed remap and not a text replace.</b> The whole-body string substitution
    /// this replaces rewrote every textual occurrence of the FormKey in the file, which for a
    /// container document means sibling records that never referenced the target, and for any record
    /// means EditorIDs and string fields that merely spell it. The typed remap moves links and only
    /// links.</para>
    ///
    /// <para><b>Why the assertion after it.</b> The typed remap is precise but not exhaustive:
    /// <c>ScriptStructListProperty.RemapLinks</c> is generated base-only and never descends into its
    /// own <c>Structs</c>, so a VMAD <c>ArrayOfStruct</c> property's Object members keep pointing at
    /// the old FormKey — written up in <c>upstream-mutagen-issue.md</c> at the repository root.
    /// mEdit's own reference index walks struct-lists (<c>VmadCodec</c>), so a referencer linked only
    /// that way <i>is</i> in this list, gets loaded here, and is caught by the textual check below
    /// rather than being written half-remapped. Delete this check when the upstream fix ships.</para>
    /// </summary>
    private RecordEditResult? ComputeReferencerRewrites(
        IRecordIndex index, string oldFormKey, string newFormKey, GameRelease release,
        IReadOnlyList<(string FormKey, PluginKey Plugin)> referencers,
        out List<ComputedRewrite> rewrites)
    {
        rewrites = [];
        var reads = index.At(RecordRef.Effective);
        var mapping = RenumberMapping(oldFormKey, newFormKey);

        var resolved = new List<(string FormKey, PluginKey Plugin, SourceUnit Unit)>();
        foreach (var (referencerFormKey, referencerPlugin) in referencers)
        {
            if (reads.GetDocument(referencerFormKey, referencerPlugin) is not { } doc)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.RecordNotFound,
                    $"{referencerPlugin.Name} no longer holds {referencerFormKey}, which the index lists " +
                    $"as referencing {oldFormKey}. Nothing was written — reindex {referencerPlugin.Name} and try again.");
            }

            var referencerModFolder = ModFolders.TrackedOf(mirror.LoadOrder, referencerPlugin)!;
            if (SourceUnitResolver.Resolve(
                    reads, referencerPlugin, referencerModFolder, referencerFormKey, doc.RecordType,
                    doc.EditorId, release)
                is not { } unit)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    $"No source unit in {referencerPlugin.Name}'s tree holds {referencerFormKey}, which " +
                    $"references {oldFormKey}. Nothing was written.");
            }

            resolved.Add((referencerFormKey, referencerPlugin, unit));
        }

        foreach (var group in resolved.GroupBy(r => (r.Plugin, r.Unit.FullPath)))
        {
            var (referencerPlugin, filePath) = group.Key;
            // Every referencer in the group shares one file, so they share its top-level record too.
            var unit = group.First().Unit;
            if (reads.GetDocument(unit.OwnerFormKey, referencerPlugin) is not { } ownerDoc)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.RecordNotFound,
                    $"{referencerPlugin.Name} no longer holds {unit.OwnerFormKey}, the record {unit.RelativePath} " +
                    $"carries. Nothing was written — reindex {referencerPlugin.Name} and try again.");
            }

            var owner = ReadRecordFromSource(_codec, logger, filePath, ownerDoc, release);
            ((IFormLinkContainer)owner).RemapLinks(mapping);
            var ownerBody = SerializeToText(owner, release);
            if (RefuseIfRemapIncomplete(owner, ownerDoc.RecordType, oldFormKey, referencerPlugin) is { } incomplete)
                return incomplete;

            var changes = new List<(string FormKey, string? Body)> { (unit.OwnerFormKey, ownerBody) };
            foreach (var (embeddedFormKey, _, _) in group.Where(r => r.Unit.IsEmbedded))
            {
                // The child's own extracted row, re-derived from the remapped owner — the same
                // two-row shape EditField's own embedded edit uses (owner's body changed, and the
                // child's row must not go stale next to it). A remap never moves a record's own
                // FormKey, only its links, so the child is still found under the same key.
                if (ContainerChildFields.FindEmbeddedChild(owner, embeddedFormKey)?.Child is not { } child)
                {
                    return RecordEditResult.Refused(
                        RecordEditRefusal.SourceUnitNotFound,
                        $"{unit.RelativePath} is indexed as carrying {embeddedFormKey}, but its own text does " +
                        "not hold it. Nothing was written.");
                }

                // The owner's own walk never reaches a child's VMAD — an embedded referencer's
                // struct-list link is its own record's, and has to be asked of the child directly.
                var childDoc = reads.GetDocument(embeddedFormKey, referencerPlugin);
                if (RefuseIfRemapIncomplete(
                        child, childDoc?.RecordType ?? unit.OwnerRecordType, oldFormKey, referencerPlugin)
                    is { } childIncomplete) return childIncomplete;

                changes.Add((embeddedFormKey, SerializeToText(child, release)));
            }

            // Carried on the rewrite rather than recomputed at write time: the write transaction names
            // every path it could not restore relative to this folder (#678), which is the form the
            // Source Control panel lists them in.
            rewrites.Add(new ComputedRewrite(
                referencerPlugin, ModFolders.TrackedOf(mirror.LoadOrder, referencerPlugin)!,
                filePath, owner, changes));
        }

        return null;
    }

    /// <summary>The one-entry FormKey mapping both compute phases apply, built from the same pair
    /// so the referencer pass and the target pass can never disagree about what is moving.</summary>
    private static Dictionary<FormKey, FormKey> RenumberMapping(string oldFormKey, string newFormKey) =>
        new() { [FormKey.Factory(oldFormKey)] = FormKey.Factory(newFormKey) };

    /// <summary>A record's own source text, as the index will be told it.</summary>
    private string SerializeToText(IMajorRecordGetter record, GameRelease release) =>
        Encoding.UTF8.GetString(_codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult());

    /// <summary>
    /// The remap-completeness guard, applied to every record the cascade is about to write — the
    /// referencers and the renumbered record itself alike. After the typed remap, no <i>link</i>
    /// in <paramref name="record"/> should still point at the old FormKey; one that does is a link
    /// Mutagen's generated <c>RemapLinks</c> did not move.
    ///
    /// <para>The known cause is the upstream gap in <c>upstream-mutagen-issue.md</c>:
    /// <c>ScriptStructListProperty.RemapLinks</c> is generated base-only and never descends into its
    /// own <c>Structs</c>, so a VMAD <c>ArrayOfStruct</c> property's Object members are left
    /// pointing at the old FormKey. It applies to a self-link in the renumbered record just as much
    /// as to a referencer's, which is why this is not the referencer pass's private business.
    /// Delete this guard when the upstream fix ships.</para>
    ///
    /// <para><b>Asked of the reference index's own walker, not of the serialized text.</b>
    /// <see cref="PluginIngest.CollectVmadRefsForRecord"/> is the same collector a fresh ingest
    /// derives <c>form_references</c> with, and it walks struct-lists (<c>VmadCodec</c>) where the
    /// generated remap does not — that asymmetry is the whole reason this can catch anything. A
    /// textual "no occurrence of the old FormKey survives" check would be broader, but it cannot
    /// tell a link from an EditorID, a string field, or a sibling record inside a container
    /// document, and would refuse a perfectly good renumber for any of them. Precision here is not
    /// a nicety: the record being renumbered may legitimately spell its own old FormKey in a string
    /// field, and refusing that is refusing the gesture outright.</para>
    /// </summary>
    private static RecordEditResult? RefuseIfRemapIncomplete(
        IMajorRecordGetter record, string recordType, string oldFormKey, PluginKey plugin)
    {
        var refs = new List<FormRef>();
        PluginIngest.CollectVmadRefsForRecord(record, recordType, refs);
        if (refs.FirstOrDefault(r => r.TargetFormKey == oldFormKey) is { TargetFormKey: not null } stale)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.ReferenceRemapIncomplete,
                $"{record.FormKey} in {plugin.Name} still links {oldFormKey} at {stale.FieldPath} after the " +
                "typed link remap, so renumbering would leave that reference dangling. The cause is a script " +
                "property holding an array of structs, which Mutagen's generated remap does not walk " +
                "(see upstream-mutagen-issue.md). Nothing was written.");
        }

        return null;
    }

    /// <summary>Phase two for one referencing file: the codec's own write-then-rename
    /// (<see cref="RecordTextCodec.SerializeAsync"/>), so a failure mid-write leaves the previous
    /// source record intact rather than truncated. Routed through <paramref name="transaction"/>, which
    /// holds the file's pre-image for the length of the call and itself wraps the write in
    /// <see cref="SourceUnitResolver.InMintedDirectory{T}"/> like every other source-tree write —
    /// the resolved unit proves the directory already exists, so nothing is normally minted, and the
    /// wrapper is what keeps that true rather than an assumption (#675).</summary>
    private void WriteComputedRewrite(
        IRecordIndex index, SourceWriteTransaction transaction, ComputedRewrite rewrite, GameRelease release)
    {
        transaction.Write(
            rewrite.ModFolder, rewrite.FilePath,
            () => _codec.SerializeAsync(rewrite.Record, rewrite.FilePath, release).GetAwaiter().GetResult());

        index.ApplyWorkingTreeChanges(rewrite.Plugin, rewrite.IndexChanges);
    }

    /// <summary>The renumbered record's own new content, computed before any write. <c>Root</c> is
    /// the record whose serialization lands at <c>Unit.FullPath</c> — the renumbered record itself
    /// when it is not embedded, its owner when it is — and <c>ChildBody</c> is the embedded child's
    /// own extracted body, <c>null</c> for a non-embedded target.</summary>
    private sealed record ComputedTarget(
        SourceUnit Unit, RecordDocument Document, IMajorRecord Root, string RootBody, string? ChildBody);

    /// <summary>
    /// Phase one for the renumbered record itself: read it, move any link it holds to the target
    /// (a self-reference — the referencer pass deliberately skips it, so this is the only place a
    /// self-link is remapped), stamp the new FormKey on, and serialize. Nothing here touches the
    /// filesystem beyond reading; both ways it can fail are typed refusals, not throws.
    /// </summary>
    private RecordEditResult? ComputeTargetRewrite(
        IRecordIndex index, PluginKey plugin, string modFolder, string oldFormKey, string newFormKey,
        GameRelease release, out ComputedTarget target)
    {
        target = null!;
        var reads = index.At(RecordRef.Effective);
        if (reads.GetDocument(oldFormKey, plugin) is not { } document)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound,
                $"{plugin.Name} no longer holds {oldFormKey}. Nothing was written — reindex {plugin.Name} and try again.");
        }

        if (SourceUnitResolver.Resolve(reads, plugin, modFolder, oldFormKey, document.RecordType, document.EditorId, release)
            is not { } unit)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.SourceUnitNotFound,
                $"No source unit in {plugin.Name}'s tree holds {oldFormKey}. Nothing was written.");
        }

        var mapping = RenumberMapping(oldFormKey, newFormKey);

        if (unit.IsEmbedded)
        {
            if (reads.GetDocument(unit.OwnerFormKey, plugin) is not { } ownerDocument)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.RecordNotFound,
                    $"{plugin.Name} no longer holds {unit.OwnerFormKey}, the record {unit.RelativePath} carries " +
                    $"{oldFormKey} inside. Nothing was written — reindex {plugin.Name} and try again.");
            }

            var owner = ReadRecordFromSource(_codec, logger, unit.FullPath, ownerDocument, release);
            if (ContainerChildFields.FindEmbeddedChild(owner, oldFormKey) is not { } found)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    $"{unit.RelativePath} is indexed as holding {oldFormKey}, but its own text does not carry it. " +
                    "Nothing was written.");
            }

            // Remapped on the owner, not the child: a sibling embedded in the same document may hold
            // the self-link, and its own file is this same one.
            ((IFormLinkContainer)owner).RemapLinks(mapping);

            // Guarded before the new FormKey is stamped on, so a refusal names the record the user
            // asked about. The renumbered record's own self-link is remapped on this path and
            // nowhere else — the referencer list excludes the target — so without this the one gap
            // the guard exists for would pass silently here.
            if (RefuseIfRemapIncomplete(owner, ownerDocument.RecordType, oldFormKey, plugin) is { } ownerIncomplete)
                return ownerIncomplete;
            if (RefuseIfRemapIncomplete(found.Child, document.RecordType, oldFormKey, plugin) is { } childIncomplete)
                return childIncomplete;

            ((IMajorRecordInternal)found.Child).FormKey = FormKey.Factory(newFormKey);

            target = new ComputedTarget(
                unit, document, owner, SerializeToText(owner, release), SerializeToText(found.Child, release));
            return null;
        }

        var record = ReadRecordFromSource(_codec, logger, unit.FullPath, document, release);
        ((IFormLinkContainer)record).RemapLinks(mapping);

        if (RefuseIfRemapIncomplete(record, document.RecordType, oldFormKey, plugin) is { } recordIncomplete)
            return recordIncomplete;

        ((IMajorRecordInternal)record).FormKey = FormKey.Factory(newFormKey);

        target = new ComputedTarget(unit, document, record, SerializeToText(record, release), ChildBody: null);
        return null;
    }

    /// <summary>Phase two for the renumbered record: the delete+create pair in source terms, moving
    /// the already-computed bytes onto disk. Dispatches on the target's own source unit shape.</summary>
    private void WriteTargetRewrite(
        IRecordIndex index, SourceWriteTransaction transaction, PluginKey plugin, string modFolder,
        ComputedTarget target, string oldFormKey, string newFormKey, GameRelease release)
    {
        var (unit, document, root, rootBody, childBody) = target;
        if (unit.IsEmbedded)
        {
            // No file moves: an embedded record has no leaf name of its own to carry a new identity.
            // The owner is reserialized over its existing file and the child's own extracted row is
            // replaced (old FormKey's row nulled, new FormKey's row created from the child alone) —
            // the same two-row shape EditField's own embedded edit uses.
            transaction.Write(
                modFolder, unit.FullPath,
                () => _codec.SerializeAsync(root, unit.FullPath, release).GetAwaiter().GetResult());
            index.ApplyRenumber(plugin, new RenumberedRecord(
                oldFormKey, newFormKey, document.RecordType, childBody!,
                new EmbeddingOwner(unit.OwnerFormKey, rootBody)));
            return;
        }

        var record = root;

        // A container's own directory (Cell/Worldspace/Quest, or a nested folder-split child) versus
        // a flat record's single file — the same distinction DeleteRecord makes, both now reading
        // SourceUnit's own IsDirectoryPerRecord rather than retyping the check.
        var isDirectoryPerRecord = unit.IsDirectoryPerRecord;
        var oldLeafPath = isDirectoryPerRecord ? Path.GetDirectoryName(unit.FullPath)! : unit.FullPath;
        var parentDirectory = Path.GetDirectoryName(oldLeafPath)!;

        // EditorID does not change across a renumber — only the FormKey half of the leaf name does.
        // The record keeps its position: its parent's ordered child list is keyed by FormKey, so the
        // renumber repoints that one entry in place below rather than moving the record to the end.
        // For DialogTopic.Responses that distinction is gameplay, not cosmetics.
        var newLeafName =
            SourceUnitResolver.LeafNameFor(FormKey.Factory(newFormKey), document.EditorId, isDirectoryPerRecord);
        var newLeafPath = Path.Combine(parentDirectory, newLeafName);

        string writePath;
        if (isDirectoryPerRecord)
        {
            // Moved whole, not recreated from scratch: a container's nested folder-split children (a
            // Quest's own DialogTopics subtree) travel with it rather than being orphaned.
            transaction.Move(modFolder, oldLeafPath, newLeafPath);
            writePath = Path.Combine(newLeafPath, SourceUnitResolver.RecordDataFileName);
        }
        else
        {
            writePath = newLeafPath;
        }
        // A no-op for the moved-whole branch above (the move already put the destination in
        // place); for the flat branch this is the group folder, which the resolved unit proves already
        // exists — so nothing is normally minted here at all, and the transaction's own
        // InMintedDirectory wrapper is what keeps that true rather than an assumption (#675).
        transaction.Write(
            modFolder, writePath,
            () => _codec.SerializeAsync(record, writePath, release).GetAwaiter().GetResult());

        if (!isDirectoryPerRecord && File.Exists(unit.FullPath)) transaction.Delete(modFolder, unit.FullPath);

        // This method's own last file-system act: the parent's ordered child list follows the record
        // onto its new FormKey, in place. Recorded like every other act here — the carrier is a file
        // this pass changed, so a failed renumber has to put it back too (#678, ADR-0045).
        if (SourceChildOrder.SlotHolding(parentDirectory, oldFormKey) is { } slot)
        {
            transaction.Write(
                modFolder, slot.Carrier,
                () => SourceChildOrder.Rename(slot.Carrier, slot.Key, oldFormKey, newFormKey));
        }

        // The whole index side of the renumber in one call, and therefore one transaction (#677):
        // the new identity's rows, the re-points that carry this record's folder-split children and
        // any exterior cells onto it, and the old identity's teardown. It replaces four separate
        // index calls on this path (three on the embedded one above), the middle two of which opened
        // no transaction at all — so a fault part-way left the earlier ones durably applied, an index
        // naming a FormKey no source file backs.
        //
        // Necessarily this method's last act rather than straddling the file work above, since the
        // four calls it replaces are now one: the create half used to run before the delete and
        // renormalize. Nothing between reads or writes the index, so the collapse only shrinks the
        // window in which disk and index disagree.
        index.ApplyRenumber(plugin, new RenumberedRecord(oldFormKey, newFormKey, document.RecordType, rootBody));
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
        var isLight = IsLightAtEffective(index, plugin, mod);

        if (requestedFormKey != null)
        {
            if (RefuseIfNotNativeTarget(requestedFormKey, plugin, isLight) is { } notNative)
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

        var allocated = NextFreeNativeFormId(index, plugin, mod, isLight);
        if (allocated != null)
        {
            targetFormKey = allocated;
            return null;
        }

        targetFormKey = "";
        // #290: the ESL cap, not the plugin's own FormKey space, is what's actually exhausted —
        // native space above 0xFFF remains free, and the light-ness is the removable header flag
        // (not a .esl extension nobody can un-flag). The same way out compile already offers
        // (remove the flag), surfaced the same way: a typed marker, not a dead end.
        var eslContradiction = isLight
            && IsLightByRemovableFlag(index, plugin, mod)
            && NextFreeNativeFormId(index, plugin, mod, isLight: false) != null;
        return RecordEditResult.Refused(
            RecordEditRefusal.FormKeySpaceExhausted, FormKeySpaceExhaustedMessage(plugin, isLight, eslContradiction),
            eslContradiction);
    }

    /// <summary>
    /// Whether <paramref name="plugin"/>'s ESL-ness comes from the removable header flag — as
    /// opposed to a <c>.esl</c> extension, which <see cref="IsLightAtEffective"/> also treats as
    /// light but which no header edit can un-flag. Same working-tree-first lookup
    /// <see cref="IsLightAtEffective"/> uses (a flag flipped this session, not yet compiled, still
    /// answers immediately), minus the extension fallback.
    /// </summary>
    private static bool IsLightByRemovableFlag(IRecordIndex index, PluginKey plugin, IModGetter? mod)
    {
        var headerFormKey = HeaderIndexer.FormKeyFor(ModKey.FromFileName(plugin.Name));
        if (index.At(RecordRef.Effective).GetDocument(headerFormKey, plugin)?.Body is { } body)
            return HeaderDocument.IsLight(Encoding.UTF8.GetBytes(body));
        return mod?.IsSmallMaster ?? false;
    }

    /// <summary>
    /// Whether <paramref name="plugin"/> is ESL-flagged, answered from its header <b>document</b> at
    /// Effective when one is indexed — the source tree is the truth (ADR-0041), and the one write
    /// door onto this flag (<see cref="EditHeaderIsLight"/>) lands there, so a flag flipped this
    /// session caps FormID minting immediately with no reconcile in between. The loaded mod object
    /// (<see cref="PluginFlagPredicates.IsLight"/>) only answers when no header document exists.
    /// </summary>
    private static bool IsLightAtEffective(IRecordIndex index, PluginKey plugin, IModGetter? mod)
    {
        var headerFormKey = HeaderIndexer.FormKeyFor(ModKey.FromFileName(plugin.Name));
        if (index.At(RecordRef.Effective).GetDocument(headerFormKey, plugin)?.Body is { } body)
        {
            return HeaderDocument.IsLight(Encoding.UTF8.GetBytes(body))
                || plugin.Name.EndsWith(".esl", StringComparison.OrdinalIgnoreCase);
        }
        return IsLightPlugin(mod, plugin);
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
    private static RecordEditResult? RefuseIfNotNativeTarget(string requestedFormKey, PluginKey plugin, bool isLight)
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

        if (isLight && parsed.ID > PluginFlagPredicates.LightLocalFormIdCap)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.LightPluginFormIdOutOfRange,
                $"{requestedFormKey} exceeds {plugin.Name}'s ESL local FormID range — a light-flagged " +
                $"plugin can only address local FormIDs up to 0x{PluginFlagPredicates.LightLocalFormIdCap:X}. " +
                "Choose a FormID within that range, or un-flag the plugin as ESL.");
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
    private static string? NextFreeNativeFormId(IRecordIndex index, PluginKey plugin, IModGetter? mod, bool isLight)
    {
        var floor = mod?.GetDefaultInitialNextFormID() ?? 0x800u;
        var highest = index.At(RecordRef.Effective).GetNativeFormKeys(plugin)
            .Concat(index.At(RecordRef.Head).GetNativeFormKeys(plugin))
            .Select(LocalId)
            .DefaultIfEmpty(0u)
            .Max();
        var next = Math.Max(floor, highest + 1);
        var cap = isLight ? PluginFlagPredicates.LightLocalFormIdCap : FormID.FullIdMask;
        return next > cap ? null : $"{next:X6}:{plugin.Name}";
    }

    private static string FormKeySpaceExhaustedMessage(PluginKey plugin, bool isLight, bool eslContradiction = false)
    {
        if (eslContradiction)
        {
            return $"{plugin.Name} has exhausted its ESL FormKey space — every local FormID up to 0xFFF is " +
                "already in use (a light-flagged plugin's addressable range) — but native space remains " +
                "free above it. Remove the ESL flag to keep creating records there.";
        }
        return isLight
            ? $"{plugin.Name} has exhausted its ESL FormKey space — every local FormID up to 0xFFF is " +
              "already in use (a light-flagged plugin's addressable range). Un-flag it as ESL to use " +
              "the full 0xFFFFFF range."
            : $"{plugin.Name} has exhausted its FormKey space — every local FormID up to 0xFFFFFF is already in use.";
    }

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
        var isLight = IsLightAtEffective(index, plugin, mod);
        var formKey = NextFreeNativeFormId(index, plugin, mod, isLight);
        return formKey != null
            ? RecordEditResult.Success(formKey)
            : RecordEditResult.Refused(
                RecordEditRefusal.FormKeySpaceExhausted, FormKeySpaceExhaustedMessage(plugin, isLight));
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
    /// <summary>The synthetic header field name the ESL flag is written through — see
    /// <see cref="EditHeaderIsLight"/>.</summary>
    internal const string IsLightFieldPath = "is_light";

    /// <summary>
    /// #290's header write: sets or clears the ESL (<c>Small</c>) flag by transforming the header's
    /// own current document (<see cref="HeaderDocument.WithLightFlag"/> — document in, canonical
    /// document out, no in-memory mod consulted, so a stale loaded-plugin object can never leak
    /// other header values into the write). The root <c>RecordData.json</c> and the index row move
    /// together, the same two-step every other edit here lands as.
    /// </summary>
    private RecordEditResult EditHeaderIsLight(
        IRecordIndex index, PluginKey plugin, SourceUnit unit, string formKey, JsonElement value)
    {
        if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FieldValueShapeMismatch, $"'{IsLightFieldPath}' takes a JSON boolean.");
        }

        var currentBody = File.Exists(unit.FullPath)
            ? File.ReadAllBytes(unit.FullPath)
            : Encoding.UTF8.GetBytes(index.At(RecordRef.Effective).GetDocument(formKey, plugin)!.Body!);
        var newBody = HeaderDocument.WithLightFlag(currentBody, value.GetBoolean());
        var newText = Encoding.UTF8.GetString(newBody);

        WriteBodyAtomic(unit.FullPath, newText);
        index.ApplyWorkingTreeChanges(plugin, [(formKey, newText)]);
        mirror.ReapplyFilter();

        // Warn, not info, per the #290 ruling: flipping this flag shifts load-order behavior
        // downstream, so the log keeps a visible record of every change to it.
        logger.LogWarning(
            "ESL flag on {Plugin} ({Origin}) set to {IsLight} via {Field}",
            plugin.Name, plugin.Origin, value.GetBoolean(), IsLightFieldPath);
        return RecordEditResult.Success();
    }

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

    // The whole-mod door's own directory-per-record file name — SourceRecordPath keeps its own copy of
    // this literal private, so this restates the same well-known constant rather than exposing it.
    private const string RecordDataFileName = "RecordData.json";

    /// <summary>
    /// The block and sub-block directory names an interior Cell nests under, reusing whichever pair
    /// the destination already has and minting one the first time — everything a
    /// <see cref="SourcePlacement"/> needs to place a Cell, and the reason a Cell needs anything extra
    /// at all: its own directory nests two GRUP levels deep (<c>Cells/&lt;block&gt;/&lt;sub-block&gt;/&lt;name&gt;/RecordData.json</c>, verified
    /// against a real Track output) rather than sitting directly under its group folder. Interior
    /// placement carries no gameplay meaning at all — <c>PlacementWalker.Walk</c>'s own interior branch
    /// never records a block/sub number in <c>cell_location</c> (verified by reading it: every interior
    /// cell's row carries null block/sub, the same as CONTEXT.md's own "the plugin's own single
    /// interior bucket" framing) — so this reuses whichever block/sub-block directory the destination
    /// already has (any one; the number is never meaningful), minting a fresh <c>[0] 0/[0] 0</c> pair
    /// only the first time a destination plugin gets an interior cell at all.
    /// </summary>
    internal static IReadOnlyList<string> EnsureInteriorCellBlockPath(
        string modFolder, string pluginName, GameRelease release)
    {
        var cellsFolder = RecordTypeDispatch.For(release).GroupFolderNameFor("cell")
            ?? throw new InvalidOperationException(
                "This game's schema has no Cell group folder — RefuseIfCopySourceHasNoContainerOfItsOwn should have refused this first.");
        var cellsDirectory = Path.Combine(modFolder, SourceRecordPath.RootFor(pluginName), cellsFolder);
        SourceUnitResolver.InMintedDirectory(cellsDirectory, () => WriteMinimalGroupRecordDataIfMissing(cellsDirectory, groupType: null));

        var blockDirectory = FindOrMintGroupDirectory(
            cellsDirectory, "InteriorCellBlock", cellsFolder);
        var subBlockDirectory = FindOrMintGroupDirectory(
            blockDirectory, "InteriorCellSubBlock", nameof(Mutagen.Bethesda.Fallout4.CellBlock.SubBlocks));

        return [Path.GetFileName(blockDirectory), Path.GetFileName(subBlockDirectory)];
    }

    /// <summary>The first existing child directory of <paramref name="parentDirectory"/>, or a
    /// freshly-minted <c>"0"</c> one carrying <paramref name="groupType"/>'s own minimal
    /// <c>GroupRecordData.json</c> when none exists yet — interior placement's own "reuse whatever
    /// bucket already exists" rule (<see cref="InteriorCellDestinationPath"/>'s own doc
    /// comment).</summary>
    /// <param name="orderKey">The member name this level is carried under in
    /// <paramref name="parentDirectory"/>'s own ordered child list — a freshly minted block has to
    /// join that list, or the next read refuses the tree as drift.</param>
    private static string FindOrMintGroupDirectory(string parentDirectory, string groupType, string orderKey)
    {
        var existing = Directory.EnumerateDirectories(parentDirectory).FirstOrDefault();
        if (existing != null) return existing;

        const string blockNumber = "0";
        var directory = Path.Combine(parentDirectory, blockNumber);
        SourceUnitResolver.InMintedDirectory(directory, () => WriteMinimalGroupRecordDataIfMissing(directory, groupType));
        SourceChildOrder.Add(
            SourceChildOrder.CarrierFor(parentDirectory, parentIsRecord: false), orderKey, blockNumber);
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
    /// <paramref name="record"/>'s own bytes — what the index will be told next — and write to
    /// <paramref name="path"/> in one atomic move. Returns the body as text, ready for whichever
    /// index-notify call the caller makes next.
    ///
    /// <para>The two serializations are separate calls, and it is
    /// <see cref="RecordTextCodec.SerializeToBytesAsync"/>/<see cref="RecordTextCodec.SerializeAsync"/>
    /// producing identical bytes for the same record — pinned by <c>RecordTextCodecInMemoryTests</c>
    /// — that makes what the index is told and what lands on disk the same text. Splitting the pair
    /// across a compute phase and a write phase, as the renumber cascade does, rests on that same
    /// guarantee and is no weaker than calling this.</para>
    /// </summary>
    internal static string SerializeAndWrite(RecordTextCodec codec, IMajorRecord record, string path, GameRelease release)
    {
        var bytes = codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();
        codec.SerializeAsync(record, path, release).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(bytes);
    }
}
