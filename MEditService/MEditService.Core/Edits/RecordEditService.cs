using System.Globalization;
using System.Text;
using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Plugins.Utility;

namespace MEditService.Core.Edits;

/// <summary>
/// The single write path (ADR-0041 / #415): a field edit on a tracked plugin becomes a working-tree
/// change to that record's source JSON, and nothing else. There is no second path — no direct binary
/// write, no staged pending state — which is why an untracked plugin is refused here rather than
/// quietly served by some other mechanism.
///
/// <para><b>The source text is the source, not the index.</b> Each edit reads the record's source
/// file, applies the field to the record that text deserializes to, and writes the file back; the
/// index is then told what landed. Reading the file rather than the indexed body is deliberate and
/// measured: ingest used to serialize from a plugin's <i>binary overlay</i> while the source held a
/// <i>deep parse</i>, and the two are not always structurally identical (#369's 1-in-3,940 hole,
/// documented on <see cref="GitBlobHash"/>). Editing the file's own bytes means an edit can never
/// silently rewrite a record's unrelated fields into the overlay's shape.
///
/// <para>#452 dissolved that specific hazard for a <b>tracked</b> plugin — which is every plugin this
/// class will edit, since editing requires tracking. Its index rows are now seeded from the same
/// source tree this reads, so there is exactly one parse and the two cannot disagree
/// (<c>SourceIngestParityTests</c> measures the residue: 2,576 of 2,577 real documents byte-identical,
/// the one exception being #369 itself, which can only appear on the untracked binary path). Reading
/// the file nonetheless stays correct and stays the rule: it is the shortest path to the bytes being
/// edited, and it keeps this class independent of how fresh the index happens to be.</para>
///
/// <para>Every refusal happens <b>before</b> anything is written, so a refused edit leaves the
/// working tree exactly as it was — there is no half-applied state for the user to discover in the
/// Source Control panel.</para>
/// </summary>
public sealed class RecordEditService(
    ISessionManager sessions,
    ISchemaReflector schemaReflector,
    ILogger<RecordEditService> logger)
{
    private readonly RecordTextCodec _codec = new(Microsoft.Extensions.Logging.Abstractions.NullLogger<RecordTextCodec>.Instance);

    /// <summary>
    /// Applies <paramref name="value"/> to <paramref name="fieldPath"/> on one plugin's copy of
    /// <paramref name="formKey"/>. Complex fields arrive as one whole value (CONTEXT.md's atomic
    /// field-level write), VMAD and condition paths included — see <see cref="RecordFieldWriter"/>
    /// for the dispatch.
    /// </summary>
    public RecordEditResult EditField(PluginKey plugin, string formKey, string fieldPath, JsonElement value)
    {
        if (RefuseIfBlocked(plugin, out var modFolder) is { } blocked) return blocked;

        var index = sessions.Index;
        if (index == null)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No session is loaded.");

        // The effective document, because that is what the user is looking at and editing from — a
        // second edit to the same record must build on the first, not on the committed baseline.
        var document = index.GetDocument(formKey, plugin);
        if (document == null)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound,
                $"{plugin.Name} does not hold record {formKey}.");
        }

        var release = sessions.Session!.GameRelease;

        // #453 scope 1: which file holds this record. A flat record's own, a container's
        // RecordData.json, or — for an embedded child (a placed ref, a landscape, a navmesh, a
        // worldspace's top cell) — its parent container's, since the child has no file of its own.
        if (SourceUnitResolver.Resolve(index, plugin, modFolder, formKey, document.RecordType, document.EditorId, release)
            is not { } unit)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.SourceUnitNotFound,
                $"No source file in {plugin.Name}'s tree holds {formKey}, and the index names no container " +
                "that would. Something moved or removed it outside Modbench — check the Source Control panel.");
        }

        var owner = index.GetDocument(unit.OwnerFormKey, plugin)!;
        var record = ReadRecordFromSource(unit.FullPath, owner, release);
        var schemas = schemaReflector.GetSchemas(release);

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
                    // Deliberately does not blame an external change (#453 review finding 2: it used
                    // to, and that was a false diagnosis for the one shape that actually reached it —
                    // a ref two levels inside a worldspace's document, which the search simply did not
                    // descend to. A wrong explanation is worse than none: it sends the user hunting a
                    // problem that is not there.) States only what is observed.
                    $"{unit.RelativePath} is indexed as holding {formKey}, but its own text does not " +
                    "carry it. If nothing outside Modbench changed that file, this is a defect — please " +
                    "report it; otherwise reload the session so the index re-reads the tree.");
            }
            target = found.Child;
        }

        if (RefuseIfContainmentField(document.RecordType, fieldPath, schemas, release) is { } containmentRefusal)
            return containmentRefusal;

        // #491: a Partial Form override's own fields are read-only — checked against `target`, not
        // `record`, so an embedded child (a REFR the override introduces) is unaffected: it is never
        // itself a container type, so PartialFormFlag.IsSet is false for it regardless of its
        // parent's own flag (CONTEXT.md's Partial Form entry: "children are unaffected — they are
        // separate records"). EditorID is exempt (#491 review): xEdit's own CanAssignInternal
        // (wbImplementation.pas:9905-9914) explicitly allows EDID assignment on a Partial Form
        // record — ADR-0034 makes xEdit's answer binding here, and #539 owning the *header* write
        // path is a sequencing choice, not a platform limitation, so it cannot justify refusing an
        // ordinary, already-writable field xEdit itself never blocks. is_partial_form is exempt too
        // (#539): it is the one write that must reach the flag while it is set — clearing it is the
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

        if (ValidateFormLinks(index, schemas, document.RecordType, fieldPath, value) is { } linkError)
            return RecordEditResult.Refused(RecordEditRefusal.InvalidFormLink, linkError);

        // #539 correction 2: two reflected columns (major_flags, fallout4_major_record_flags — and,
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

        // #453 scope 3: the file name carries the EditorID, so an EditorID edit is a rename as well as
        // a content change. Done before the write, deliberately — see RenameSourceUnit.
        var sourcePath = RenameSourceUnit(unit, target, document);

        var newBody = _codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();

        // #412: the codec's own file write is atomic (temp file, then rename), which matters more
        // here than at Track — this file is inside a live git working tree that the SCM panel, and
        // git itself, may read at any moment.
        _codec.SerializeAsync(record, sourcePath, release).GetAwaiter().GetResult();

        // #453 scope 4: an embedded edit dirties *two* rows — the parent source unit, whose bytes
        // moved, and the child, whose own document is what the read model serves for it. Both go
        // through the one ApplyWorkingTreeChanges call, so they land in a single transaction.
        var deltas = new List<(string FormKey, string? Body)>
        {
            (unit.OwnerFormKey, Encoding.UTF8.GetString(newBody)),
        };
        if (unit.IsEmbedded)
        {
            deltas.Add((formKey, Encoding.UTF8.GetString(
                _codec.SerializeToBytesAsync(target, release).GetAwaiter().GetResult())));
        }
        index.ApplyWorkingTreeChanges(plugin, deltas);

        // #422: the new value can flip filter membership either way.
        sessions.ReapplyFilter();

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
    /// alone — #453's own containment guard, and the reason no index side table can go stale through
    /// a field edit.
    ///
    /// <para>Reflection makes a container's child slots ordinary writable columns:
    /// <c>Cell.{Landscape,NavigationMeshes}</c> and <c>Worldspace.{TopCell,SubCells}</c> all reflect as
    /// struct/array columns with an <c>Apply</c>. Before #453 that was unreachable, because
    /// <see cref="EditField"/> refused every container outright. It is reachable now, and writing one
    /// would replace a container's <i>child set</i> through a JSON blob: the replaced children keep
    /// their own <c>records</c> rows and their <c>container_child</c> parentage while no longer being
    /// in any parent, which is silent index corruption rather than an edit. Changing which records a
    /// container holds is a structural gesture (<b>#461</b>), not a field write, and "containment is
    /// the path" is ADR-0041's #444 amendment talking — so the path, not a field, is what expresses
    /// it.</para>
    ///
    /// <para><c>Cell.Grid</c> is refused for the neighbouring reason: an exterior cell's grid
    /// coordinates <i>are</i> its directory (<c>Worldspaces/&lt;ws&gt;/&lt;X, Y&gt;/&lt;X, Y&gt;/…</c>),
    /// so moving it is a tree restructure and not a rewrite of one file, and the same two numbers are
    /// mirrored in <c>cell_location</c>, which nothing on this path re-derives. #454 made compile
    /// <i>read</i> that structure and deliberately did not make anything <i>move</i> a record within it,
    /// so this stays a refusal and gives the same structural-gesture reason as the slot columns above,
    /// rather than naming a ticket that has since landed without changing the answer.</para>
    ///
    /// <para><b>This is what closes the side-table question, and it closes it completely rather than
    /// per-table.</b> <c>cell_location</c>'s only non-containment columns are the grid, refused here.
    /// <c>container_child</c> is containment and slot order throughout, and the slots that could
    /// change it are refused here too. <c>placement</c>'s only non-containment column is
    /// <c>Position</c> (a <c>P3Float</c>) — also refused here (#541), since #541 gave the schema
    /// reflector a general <c>P3Int16</c>/<c>P3Float</c> mapping (needed for <c>ObjectBounds</c> and
    /// several other fields with no side-table mirror), which made <c>Position</c> an ordinary
    /// writable column on every <c>IPlacedGetter</c> type for the first time — this file used to rely
    /// on the reflector never mapping <c>P3Float</c> at all, verified rather than assumed at the time,
    /// but that verification is what #541 changed; the guard below is what keeps the conclusion true
    /// now that the premise no longer holds on its own. So after this guard, every side table is
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
                "reordering a container's children is a structural gesture (#461), not a field edit.");
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

        // #541: Position is mirrored into the `placement` side table (PlacementWalker), with no
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
    /// Moves the source unit when the edit changed the EditorID its own name carries (#453 scope 3),
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
    /// <para><b>That "still findable" is load-bearing, and it was not true when this first shipped</b>
    /// (#453 review finding 1). Resolution computed the flat path from the indexed EditorID and stopped
    /// there, so a name/content divergence read as an absent file and marked a live record deleted. The
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
    /// measured in the AC2 tests rather than assumed here.</para>
    /// </summary>
    private string RenameSourceUnit(SourceUnit unit, IMajorRecord edited, RecordDocument document)
    {
        // An embedded child's EditorID appears in no path: the file belongs to its parent, whose own
        // EditorID this edit did not touch. Nothing to move.
        if (unit.IsEmbedded) return unit.FullPath;
        if (string.Equals(edited.EditorID, document.EditorId, StringComparison.Ordinal)) return unit.FullPath;

        var isDirectoryPerRecord = unit.IsDirectoryPerRecord;
        var oldLeafPath = isDirectoryPerRecord ? Path.GetDirectoryName(unit.FullPath)! : unit.FullPath;

        // #459: an EditorID-only rename must not silently drop the record back to the front of its
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
    /// #427: deletes one plugin's copy of <paramref name="formKey"/> as a working-tree change — the
    /// source file goes away, and <see cref="IRecordIndex.ApplyWorkingTreeChanges"/>'s null-Body case
    /// (the mechanism #415 landed and tested in both flip directions) takes it from there: gone at
    /// Effective, still served at Head until this is committed and compiled. No reference cascade —
    /// a FormLink elsewhere pointing at the deleted record goes dangling and surfaces as an ordinary
    /// compile diagnostic, exactly like any other dangling link (ADR-0041).
    ///
    /// <para><b>#461 widened this off the flat-only path onto <see cref="SourceUnitResolver"/></b>,
    /// the same resolution <see cref="EditField"/> already uses, so a container's own record (its
    /// directory, cascading every embedded/folder-split descendant's index row) and an embedded
    /// child (spliced out of its owner's inline slot, the owner rewritten) both delete through this
    /// one method instead of refusing outright. A flat record resolves exactly as it always did —
    /// <see cref="SourceUnitResolver.Resolve"/>'s own flat branch <i>is</i>
    /// <see cref="SourceUnitResolver.FlatSourcePath"/> — so nothing about that case changed.</para>
    /// </summary>
    public RecordEditResult DeleteRecord(PluginKey plugin, string formKey)
    {
        if (RefuseIfBlocked(plugin, out var modFolder) is { } blocked) return blocked;

        var index = sessions.Index;
        if (index == null)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No session is loaded.");

        var document = index.GetDocument(formKey, plugin);
        if (document == null)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound,
                $"{plugin.Name} does not hold record {formKey}.");
        }

        var release = sessions.Session!.GameRelease;

        if (SourceUnitResolver.Resolve(index, plugin, modFolder, formKey, document.RecordType, document.EditorId, release)
            is not { } unit)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.SourceUnitNotFound,
                $"No source file in {plugin.Name}'s tree holds {formKey}, and the index names no container " +
                "that would. Something moved or removed it outside Modbench — check the Source Control panel.");
        }

        var deltas = new List<(string FormKey, string? Body)>();

        if (unit.IsEmbedded)
        {
            var owner = index.GetDocument(unit.OwnerFormKey, plugin)!;
            var record = ReadRecordFromSource(unit.FullPath, owner, release);

            if (!ContainerChildFields.RemoveEmbeddedChild(record, formKey))
            {
                // Same "indexed but not actually there" diagnosis EditField's own embedded lookup
                // gives — states only what is observed, never guesses an external-change cause.
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    $"{unit.RelativePath} is indexed as holding {formKey}, but its own text does not " +
                    "carry it. If nothing outside Modbench changed that file, this is a defect — please " +
                    "report it; otherwise reload the session so the index re-reads the tree.");
            }

            var newOwnerBody = _codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();
            _codec.SerializeAsync(record, unit.FullPath, release).GetAwaiter().GetResult();
            deltas.Add((unit.OwnerFormKey, Encoding.UTF8.GetString(newOwnerBody)));
        }
        else
        {
            // #488: a folder-split child's container_child.SlotIndex mirrors its own "[N]" file-name
            // prefix (#459) — captured before anything moves, so the survivors' new positions can be
            // computed the same way RenormalizeGroupOrder computes them on disk below (sort by old
            // rank ascending, assign 0..k-1). Null for a top-level container/flat record, which is
            // nobody's folder-split child.
            var parentLink = index.GetContainerParent(plugin, formKey);

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

            // #489: the delete's own last file-system act — closes whatever "[N]" gap it just left in
            // the touched group directory, so the source tree's own working invariant (every group
            // directory contiguous, SourceUnitResolver's own doc comment) holds again before this
            // returns, rather than merely being restorable by a later re-Track.
            SourceUnitResolver.RenormalizeGroupOrder(groupDirectory);

            // #488: container_child's own copy of that same renumbering — the deleted child's row
            // disappears for free (it is simply not among the survivors passed in), and every
            // surviving sibling's SlotIndex lands exactly where a fresh ingest of the renormalized
            // tree would put it.
            if (parentLink is { } parent)
            {
                var survivors = index.GetContainerChildren(plugin, parent.ParentFormKey)
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
        foreach (var descendant in EnumerateDescendantFormKeys(index, plugin, formKey))
            deltas.Add((descendant, null));

        index.ApplyWorkingTreeChanges(plugin, deltas);
        // #422: a deleted row can no longer match an active filter.
        sessions.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Deleted {FormKey} from {Plugin} ({Origin}) — working-tree deletion of {SourcePath} ({Count} index row(s) removed)",
                formKey, plugin.Name, plugin.Origin, unit.RelativePath, deltas.Count);
        }
        return RecordEditResult.Success();
    }

    /// <summary>
    /// #461: every descendant <paramref name="formKey"/> holds, recursively — a Cell's placed refs
    /// (<see cref="IRecordReads.GetCellReferences"/>), a Worldspace's TopCell
    /// (<see cref="IRecordReads.GetWorldspaceCells"/>, every row with no block coordinates — #496:
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

        // #496: every block-less cell-location row, not just the first — the same fix #251 made in
        // WorldspaceQueryService.GetWorldspaceBlocks for the identical FirstOrDefault shape. A
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
    /// #427: mints a brand-new record — the create half of a lifecycle gesture. The FormKey is either
    /// <paramref name="requestedFormKey"/> (xEdit's typed-FormID path) or, when null, the next free
    /// local FormID under the plugin's own ModKey, collision-checked against both
    /// <see cref="RecordRef.Effective"/> and <see cref="RecordRef.Head"/> so an uncompiled prior
    /// create or a working-tree-deleted record can never be handed out twice.
    /// </summary>
    public RecordEditResult CreateRecord(PluginKey plugin, string recordType, string? editorId, string? requestedFormKey = null)
    {
        if (RefuseIfBlocked(plugin, out var modFolder) is { } blocked) return blocked;

        var index = sessions.Index;
        if (index == null)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No session is loaded.");

        var release = sessions.Session!.GameRelease;
        var schemas = schemaReflector.GetSchemas(release);
        if (recordType == HeaderIndexer.TableName || !schemas.TryGetValue(recordType, out var schema))
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

        // #459: a brand-new sibling goes at the end of its group folder, one past whatever "[N] " is
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

        var newBody = _codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();
        _codec.SerializeAsync(record, sourcePath, release).GetAwaiter().GetResult();

        // #489: defensive, not merely a repeat of the invariant NextOrderIndexFor above already
        // upholds — never-assume-exclusive-ownership means this group folder can already hold a gap
        // nothing here caused (a hand-deleted sibling, another tool's edit), and this closes it as part
        // of the same write rather than leaving it for the next structural write to trip over.
        SourceUnitResolver.RenormalizeGroupOrder(Path.GetDirectoryName(sourcePath)!);

        index.CreateWorkingTreeRecord(plugin, targetFormKey, recordType, Encoding.UTF8.GetString(newBody));
        // #422: a brand-new row can newly match an active filter.
        sessions.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Created {RecordType} {FormKey} in {Plugin} ({Origin}) — new working-tree source file at {SourcePath}",
                recordType, targetFormKey, plugin.Name, plugin.Origin, relativePath);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    /// <summary>
    /// #436 (ADR-0041 restoration): xEdit's "Copy as Override Into…" — <paramref name="formKey"/>'s
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
        if (RefuseIfBlocked(destinationPlugin, out var destinationModFolder) is { } blocked) return blocked;

        var index = sessions.Index;
        if (index == null)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No session is loaded.");

        var document = index.GetDocument(formKey, sourcePlugin);
        if (document == null)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound,
                $"{sourcePlugin.Name} does not hold record {formKey}.");
        }

        var release = sessions.Session!.GameRelease;

        // #440 Slices 6/7: a placed reference (a Cell's Persistent/Temporary child) has its own,
        // parent-chain-aware handling — it never reaches RefuseIfCopySourceHasNoContainerOfItsOwn's
        // blanket refusal below at all. GetPlacement answering is exactly what distinguishes "a placed
        // reference" from every other embedded/folder-split type that predicate still refuses
        // (Landscape, NavigationMesh, DialogTopic, Scene — out of this ticket's scope).
        if (RecordTypeDispatch.For(release).GroupFolderNameFor(document.RecordType) is null
            && index.GetPlacement(formKey, sourcePlugin) is { } placement)
        {
            return CopyPlacedReferenceAsOverride(
                sourcePlugin, formKey, document, placement, destinationPlugin, destinationModFolder, index, release);
        }

        if (RefuseIfCopySourceHasNoContainerOfItsOwn(document.RecordType, release) is { } containerRefusal) return containerRefusal;

        if (!IsFreeAtBothRefs(index, destinationPlugin, formKey))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{formKey} is already held by a record in {destinationPlugin.Name} at some ref.");
        }

        // #440 review (Spec 3): IsInterior does double duty here — it is false both for a genuine
        // exterior SubCells cell (real block/sub/grid coordinates once placed) and for a Worldspace's
        // own TopCell (PlacementWalker.WalkWorldspace hardcodes isInterior: false for it, even though
        // TopCell carries no block/sub/grid either — the same "no coordinates to compute" property that
        // justifies interior auto-create). #549 Arc B only widens the genuine-SubCells-cell case (it has
        // a real CellLocationRow with block/sub/grid to mint from); a TopCell's own cell_location row
        // carries none of those (WalkWorldspace's own hardcoded nulls), so it still falls through to the
        // refusal below exactly as before — TopCell's own spatial placement is Arc B's own WRLD-scale
        // follow-up (#596), not this AC.
        var isCell = RecordTypeDispatch.For(release).ConcreteFor(document.RecordType)?.Name == "Cell";
        var cellLocation = isCell ? index.GetCellLocation(sourcePlugin, formKey) : null;
        if (isCell && cellLocation?.IsInterior == false && cellLocation.Value.BlockX != null)
        {
            var cellRecord = ReadCopySourceRecord(sourcePlugin, formKey, document, release);
            ContainerChildFields.ClearAllChildSlots(cellRecord);
            return MintExteriorCell(
                sourcePlugin, formKey, cellLocation.Value, cellRecord, document.RecordType,
                destinationPlugin, destinationModFolder, index, release);
        }
        if (isCell && cellLocation?.IsInterior != true)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.ContainerParentMissingInDestination,
                $"{formKey} is an exterior cell — copying it as override needs spatial placement " +
                "(worldspace block/sub-block) this write path does not compute yet, tracked separately.");
        }

        var body = ReadCopySourceBody(sourcePlugin, formKey, document, release);

        // #440: a flat type keeps CreateRecord's own shape (next order index in the destination's own
        // group folder, a brand-new file there). A directory-per-record container's own top-level
        // record needs its own RecordData.json directory instead — an interior Cell nests two GRUP
        // levels deeper than Worldspace/Quest do (InteriorCellDestinationPath's own doc comment), which
        // is why it is not just another call to ContainerOwnDirectoryPath.
        string relativePath;
        var isFlat = RecordTypeDispatch.For(release).FolderNameFor(document.RecordType) is not null;
        if (isFlat)
        {
            var orderIndex = SourceUnitResolver.NextOrderIndexFor(destinationModFolder, destinationPlugin.Name, document.RecordType, release);
            relativePath = SourceRecordPath.For(destinationPlugin.Name, document.RecordType, formKey, document.EditorId, release, orderIndex);
        }
        else
        {
            // #440 AC3: a plain Copy as Override is own-fields-only for every record type — for a
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
        // #422: a brand-new row can newly match an active filter.
        sessions.ReapplyFilter();

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
    /// #440 Slices 6/7 (AC2): Copy as Override for a placed reference — appends
    /// <paramref name="formKey"/> into the destination's existing override of its own Cell
    /// (<paramref name="placement"/>'s <see cref="PlacementRow.ParentCell"/>) when one already exists,
    /// touching nothing else about that Cell (not even its Partial Form flag). When the destination has
    /// no override of that Cell yet and the Cell is interior, one is auto-created first — bare fields,
    /// Partial Form flagged. Bare fields are genuine xEdit parity; Partial Form is a deliberate
    /// mEdit-specific divergence from what xEdit itself does — <see cref="CreateInteriorCellParent"/>'s
    /// own doc comment has the full trace and argument, not repeated here. An exterior Cell with no
    /// destination override refuses before this method is even reached
    /// (<see cref="CopyRecordAsOverride"/>'s own <c>ContainerParentMissingInDestination</c> check runs
    /// first): #549's own scope, not this one's.
    /// </summary>
    private RecordEditResult CopyPlacedReferenceAsOverride(
        PluginKey sourcePlugin, string formKey, RecordDocument document, PlacementRow placement,
        PluginKey destinationPlugin, string destinationModFolder, IRecordIndex index, GameRelease release)
    {
        if (!IsFreeAtBothRefs(index, destinationPlugin, formKey))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{formKey} is already held by a record in {destinationPlugin.Name} at some ref.");
        }

        var cellFormKey = placement.ParentCell;
        var cellDocument = index.GetDocument(cellFormKey, destinationPlugin);
        if (cellDocument == null)
        {
            // IsInterior's own double-duty note lives on CopyRecordAsOverride's identical check —
            // #549 Arc B only widens the genuine-SubCells case (a real BlockX to mint from); a
            // TopCell ref's own cell_location row carries none, so it still falls to the refusal below.
            var sourceCellLocation = index.GetCellLocation(sourcePlugin, cellFormKey);
            if (sourceCellLocation?.IsInterior == false && sourceCellLocation.Value.BlockX != null)
            {
                var cellSchema = schemaReflector.GetSchemas(release)["cell"];
                var bareCellRecord = MajorRecordInstantiator.Activator(FormKey.Factory(cellFormKey), release, cellSchema.RecordType);
                PartialFormFlag.Set(bareCellRecord, true);

                var childRecordForMint = _codec
                    .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body!), release, document.RecordType)
                    .GetAwaiter().GetResult();
                var mintSlotName = placement.PlacementGroup.Equals("persistent", StringComparison.Ordinal) ? "Persistent" : "Temporary";
                ContainerChildFields.AddChildToSlot(bareCellRecord, mintSlotName, childRecordForMint);

                var mintResult = MintExteriorCell(
                    sourcePlugin, cellFormKey, sourceCellLocation.Value, bareCellRecord, "cell",
                    destinationPlugin, destinationModFolder, index, release);
                if (!mintResult.Applied) return mintResult;

                // MintExteriorCell already wrote the worldspace's and cell's own rows (the REFR
                // embedded in the cell's freshly-minted body); only the REFR's own row remains —
                // the same "child first" ordering CreateInteriorCellParent's own sibling path uses,
                // moot here since the cell's row already carries the child inline either way.
                index.CreateWorkingTreeRecord(destinationPlugin, formKey, document.RecordType, document.Body!);
                sessions.ReapplyFilter();

                if (logger.IsEnabled(LogLevel.Information))
                {
                    logger.LogInformation(
                        "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into " +
                        "{DestinationPlugin} ({DestinationOrigin}) — minted exterior cell {CellFormKey} " +
                        "and its worldspace as Partial Form ancestors",
                        formKey, sourcePlugin.Name, sourcePlugin.Origin, destinationPlugin.Name,
                        destinationPlugin.Origin, cellFormKey);
                }
                return RecordEditResult.Success();
            }

            if (sourceCellLocation?.IsInterior != true)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.ContainerParentMissingInDestination,
                    $"{destinationPlugin.Name} has no override of {cellFormKey}, the cell {formKey} belongs to, " +
                    "and it is an exterior cell — auto-creating one needs spatial placement (worldspace " +
                    "block/sub-block) this write path does not compute yet, tracked separately.");
            }

            cellDocument = CreateInteriorCellParent(sourcePlugin, cellFormKey, destinationPlugin, destinationModFolder, index, release);
        }

        var cellUnit = SourceUnitResolver.Resolve(
            index, destinationPlugin, destinationModFolder, cellFormKey, cellDocument.RecordType, cellDocument.EditorId, release)
            ?? throw new InvalidOperationException(
                $"{cellFormKey} is indexed in {destinationPlugin.Name} but SourceUnitResolver cannot find its source unit.");

        var cellRecord = ReadRecordFromSource(cellUnit.FullPath, cellDocument, release);
        var childRecord = _codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body!), release, document.RecordType)
            .GetAwaiter().GetResult();
        var slotName = placement.PlacementGroup.Equals("persistent", StringComparison.Ordinal) ? "Persistent" : "Temporary";
        ContainerChildFields.AddChildToSlot(cellRecord, slotName, childRecord);

        var newCellBody = _codec.SerializeToBytesAsync(cellRecord, release).GetAwaiter().GetResult();
        _codec.SerializeAsync(cellRecord, cellUnit.FullPath, release).GetAwaiter().GetResult();

        // Two rows change: the child's own (new — CreateWorkingTreeRecord, the same "exists at neither
        // ref yet" shape every other copy-as-override uses) and the Cell's own existing row (its body
        // moved — ApplyWorkingTreeChanges, the same shape EditField's own embedded-child write uses).
        // Child first, so nothing ever transiently points a placement/container_child row at a FormKey
        // with no records row of its own.
        try
        {
            index.CreateWorkingTreeRecord(destinationPlugin, formKey, document.RecordType, document.Body!);
            index.ApplyWorkingTreeChanges(destinationPlugin, [(cellFormKey, Encoding.UTF8.GetString(newCellBody))]);
        }
        catch (Exception ex)
        {
            // #440 review (Standards 3): the Cell's file on disk already carries formKey's new bytes
            // (WriteBodyAtomic-equivalent SerializeAsync above already landed) — a should-never-happen
            // guard in one of these two calls must not surface as a bare, unhandled exception that says
            // nothing about that. RecordEditRefusal's own doc comment has the full argument.
            logger.LogError(
                ex, "Index update failed after writing {CellFormKey}'s new body to {SourcePath} for copied child {FormKey}",
                cellFormKey, cellUnit.FullPath, formKey);
            return RecordEditResult.Refused(
                RecordEditRefusal.ContainerCopyIndexUpdateFailedAfterWrite,
                $"{cellFormKey}'s working-tree file was updated to carry {formKey}, but the index failed to " +
                $"record it ({ex.Message}). The file itself is a real, reviewable working-tree change — check " +
                "the Source Control panel, or reload the session to re-index it.");
        }
        sessions.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — appended into {CellFormKey}'s {SlotName} slot",
                formKey, sourcePlugin.Name, sourcePlugin.Origin, destinationPlugin.Name, destinationPlugin.Origin,
                cellFormKey, slotName);
        }
        return RecordEditResult.Success();
    }

    /// <summary>
    /// #549 Arc B (AC1): mints <paramref name="cellLocation"/>'s exterior CELL
    /// (<paramref name="cellRecord"/> — already the right shape, either the real requested copy with
    /// its embedded children stripped, or a bare auto-created ancestor holding just a copied REFR) at
    /// its exact worldspace block/sub-block, auto-creating a bare, Partial-Form WRLD ancestor first
    /// when the destination has none (Q2, the same idiom <see cref="CreateInteriorCellParent"/> already
    /// uses one level up — bare fields, no EditorID, <see cref="PartialFormFlag.Set"/> before
    /// serializing). Shared by <see cref="CopyRecordAsOverride"/>'s own exterior-Cell branch and
    /// <see cref="CopyPlacedReferenceAsOverride"/>'s own exterior branch — the two places #440 left an
    /// explicit "spatial placement not computed yet" refusal for #549 to widen.
    ///
    /// <para>Never mints into a worldspace the destination already overrides: a second mint into an
    /// already-existing WRLD directory risks a colliding sibling folder for the same FormKey rather
    /// than landing inside the one that already exists there — genuinely out of AC1's scope ("no
    /// CELL/WRLD override" in the destination to start with), refused rather than silently routed
    /// around or half-implemented.</para>
    ///
    /// <para>Writes the worldspace's and cell's own index rows from the exact bytes
    /// <see cref="SpatialContainerMint.MintAsync"/> wrote to the working tree
    /// (<see cref="SpatialContainerMint.SpatialMintResult"/>), never a second, independently-serialized
    /// copy — the same "the source text is the source, not the index" rule this class states for every
    /// other write path.</para>
    /// </summary>
    private RecordEditResult MintExteriorCell(
        PluginKey sourcePlugin, string cellFormKey, CellLocationRow cellLocation, IMajorRecord cellRecord,
        string cellRecordType, PluginKey destinationPlugin, string destinationModFolder, IRecordIndex index,
        GameRelease release)
    {
        if (!IsFreeAtBothRefs(index, destinationPlugin, cellFormKey))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{cellFormKey} is already held by a record in {destinationPlugin.Name} at some ref.");
        }

        if (cellLocation.ParentWorldspace is not { } worldspaceFormKey)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.ContainerParentMissingInDestination,
                $"{cellFormKey} has no recorded parent worldspace — cannot place it.");
        }

        if (index.GetDocument(worldspaceFormKey, destinationPlugin) != null)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.ContainerParentMissingInDestination,
                $"{destinationPlugin.Name} already overrides worldspace {worldspaceFormKey} — minting a " +
                "second spatial subtree into an existing override needs spatial placement this write path " +
                "does not support yet, tracked separately.");
        }

        var sourceWorldspaceDocument = index.GetDocument(worldspaceFormKey, sourcePlugin)
            ?? throw new InvalidOperationException(
                $"{sourcePlugin.Name} does not hold {worldspaceFormKey} — cell_location resolved this FormKey from its own row.");

        var worldspaceSchema = schemaReflector.GetSchemas(release)["wrld"];
        var worldspaceAncestor = MajorRecordInstantiator.Activator(FormKey.Factory(worldspaceFormKey), release, worldspaceSchema.RecordType);
        PartialFormFlag.Set(worldspaceAncestor, true);

        var syntheticMod = SpatialContainerMint.BuildSyntheticWorldspaceMod(
            destinationPlugin, worldspaceAncestor, cellLocation, cellRecord);
        var minted = SpatialContainerMint.MintAsync(syntheticMod, destinationModFolder, destinationPlugin.Name)
            .GetAwaiter().GetResult();

        index.CreateWorkingTreeRecord(
            destinationPlugin, worldspaceFormKey, sourceWorldspaceDocument.RecordType,
            Encoding.UTF8.GetString(minted.WorldspaceBody));
        index.CreateCellLocation(destinationPlugin, cellLocation);
        index.CreateWorkingTreeRecord(destinationPlugin, cellFormKey, cellRecordType, Encoding.UTF8.GetString(minted.CellBody));

        return RecordEditResult.Success();
    }

    /// <summary>
    /// #440 Slice 7: silently creates <paramref name="cellFormKey"/> as an override in
    /// <paramref name="destinationPlugin"/> — the parent-chain auto-create AC1/AC2's sibling shapes
    /// need when a copied child's own Cell has no destination override yet. Bare, default-constructed
    /// fields, no EditorID (<see cref="MajorRecordInstantiator.Activator"/>, the same factory
    /// <see cref="CreateRecord"/> uses, with no <c>record.EditorID = ...</c> follow-up) — xEdit's own
    /// <c>AddIfMissingInternal</c> genuinely does the same (<c>wbImplementation.pas</c>'s ancestor walk:
    /// its <c>Assign()</c> call, which is what would otherwise copy the master's fields and name, only
    /// runs inside an <c>if aDeepCopy then</c> branch that is hardcoded <c>False</c> for every
    /// auto-created ancestor), so this half is genuine ADR-0034 parity, not an approximation of it.
    ///
    /// <para><b>Partial Form is not xEdit parity, and is not claimed as such — #440 review correction
    /// (2026-08-28 grilling session, Q2 revisited).</b> The same ancestor-walk trace that confirms the
    /// bare-fields parity above also shows real xEdit's own <c>IsPartialForm := True</c> line sits
    /// inside that same <c>if aDeepCopy then</c> branch — so xEdit itself leaves an auto-created
    /// ancestor Cell unflagged, not Partial Form. Setting it here is a deliberate mEdit-specific
    /// divergence, argued rather than assumed: Partial Form's whole purpose in this codebase (#491/
    /// #539, already shipped) is excluding a record's own fields from mEdit's git-native conflict-diff
    /// engine, which has no xEdit analog at all (root CLAUDE.md's own carve-out — tracking/compile/
    /// branch UX is scored against this product's own model, not xEdit's live in-memory comparison). A
    /// structurally-stub auto-created ancestor, whose fields were never meant to mean anything, is
    /// exactly the record that mechanism exists to exclude. <see cref="PartialFormFlag.Set"/> is #539's
    /// own write surface, called directly here since there is no source file yet for
    /// <see cref="RecordEditService.EditField"/>'s own <c>is_partial_form</c> door to reach.</para>
    /// </summary>
    private RecordDocument CreateInteriorCellParent(
        PluginKey sourcePlugin, string cellFormKey, PluginKey destinationPlugin, string destinationModFolder,
        IRecordIndex index, GameRelease release)
    {
        var sourceCellDocument = index.GetDocument(cellFormKey, sourcePlugin)
            ?? throw new InvalidOperationException(
                $"{sourcePlugin.Name} does not hold {cellFormKey} — CopyPlacedReferenceAsOverride resolved this FormKey from its own placement row.");

        var cellSchema = schemaReflector.GetSchemas(release)["cell"];
        var record = MajorRecordInstantiator.Activator(FormKey.Factory(cellFormKey), release, cellSchema.RecordType);
        PartialFormFlag.Set(record, true);

        var relativePath = InteriorCellDestinationPath(
            destinationModFolder, destinationPlugin.Name, cellFormKey, editorId: null, release);
        var sourcePath = Path.Combine(destinationModFolder, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(sourcePath)!);

        var newBody = _codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();
        _codec.SerializeAsync(record, sourcePath, release).GetAwaiter().GetResult();

        SourceUnitResolver.RenormalizeGroupOrder(Path.GetDirectoryName(sourcePath)!);

        var bodyText = Encoding.UTF8.GetString(newBody);
        index.CreateWorkingTreeRecord(destinationPlugin, cellFormKey, sourceCellDocument.RecordType, bodyText);
        sessions.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Auto-created {FormKey} as a Partial Form override in {DestinationPlugin} ({DestinationOrigin}) " +
                "— parent chain for a copied child",
                cellFormKey, destinationPlugin.Name, destinationPlugin.Origin);
        }

        return index.GetDocument(cellFormKey, destinationPlugin)!;
    }

    /// <summary>
    /// #436 (ADR-0041 restoration): xEdit's "Copy as New Record Into…" — a deep copy of
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
        if (RefuseIfBlocked(destinationPlugin, out var destinationModFolder) is { } blocked) return blocked;

        var index = sessions.Index;
        if (index == null)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No session is loaded.");

        var document = index.GetDocument(formKey, sourcePlugin);
        if (document == null)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound,
                $"{sourcePlugin.Name} does not hold record {formKey}.");
        }

        var release = sessions.Session!.GameRelease;
        if (RefuseIfDisallowedForCopyAsNewRecord(document.RecordType) is { } disallowedRefusal) return disallowedRefusal;
        if (RefuseIfContainerType(document.RecordType, release) is { } containerRefusal) return containerRefusal;

        if (ResolveTargetFormKey(index, destinationPlugin, requestedFormKey, out var targetFormKey) is { } refusedTarget)
            return refusedTarget;

        var sourceRecord = ReadCopySourceRecord(sourcePlugin, formKey, document, release);
        var newRecord = sourceRecord.Duplicate(FormKey.Factory(targetFormKey));
        if (newRecord is IFormLinkContainer selfLinking)
        {
            selfLinking.RemapLinks(new Dictionary<FormKey, FormKey> { [FormKey.Factory(formKey)] = FormKey.Factory(targetFormKey) });
        }

        var orderIndex = SourceUnitResolver.NextOrderIndexFor(destinationModFolder, destinationPlugin.Name, document.RecordType, release);
        var relativePath = SourceRecordPath.For(destinationPlugin.Name, document.RecordType, targetFormKey, newRecord.EditorID, release, orderIndex);
        var sourcePath = Path.Combine(destinationModFolder, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(sourcePath)!);

        var newBody = _codec.SerializeToBytesAsync(newRecord, release).GetAwaiter().GetResult();
        _codec.SerializeAsync(newRecord, sourcePath, release).GetAwaiter().GetResult();

        SourceUnitResolver.RenormalizeGroupOrder(Path.GetDirectoryName(sourcePath)!);

        index.CreateWorkingTreeRecord(destinationPlugin, targetFormKey, document.RecordType, Encoding.UTF8.GetString(newBody));
        // #422: a brand-new row can newly match an active filter.
        sessions.ReapplyFilter();

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

    /// <summary>Copy as Override's own seed read (#436): the record's source text, verbatim — no
    /// Mutagen deserialization, since <see cref="RecordDocument.Body"/> is already byte-identical to
    /// the source file. Mirrors <see cref="EditField"/>'s read posture for a tracked plugin (the
    /// file's current bytes, not a stale index snapshot) and falls back to the indexed body for an
    /// untracked one — the only representation that exists for it.</summary>
    private string ReadCopySourceBody(PluginKey sourcePlugin, string formKey, RecordDocument document, GameRelease release)
    {
        if (ModFolders.TrackedOf(sessions.Session, sourcePlugin) is { } sourceModFolder)
        {
            var fullPath = SourceUnitResolver.FlatSourcePath(
                sourceModFolder, sourcePlugin.Name, document.RecordType, formKey, document.EditorId, release);
            if (File.Exists(fullPath)) return File.ReadAllText(fullPath);

            // #453's own never-assume-exclusive-ownership diagnostic (ReadRecordFromSource), for the
            // same case here: a tracked source whose file went missing outside Modbench between the
            // session loading and this copy running — worth knowing about, unlike the untracked
            // fallback below, which is the expected, silent case.
            logger.LogWarning(
                "Source file {SourcePath} is missing; copying from the indexed document instead", fullPath);
        }
        return document.Body!;
    }

    /// <summary>Copy as New Record's own seed read (#436): the same posture as
    /// <see cref="ReadCopySourceBody"/>, but deserialized to a Mutagen record — <c>Duplicate</c> needs
    /// an object to copy, unlike the override path.</summary>
    private IMajorRecord ReadCopySourceRecord(PluginKey sourcePlugin, string formKey, RecordDocument document, GameRelease release)
    {
        if (ModFolders.TrackedOf(sessions.Session, sourcePlugin) is { } sourceModFolder)
        {
            var fullPath = SourceUnitResolver.FlatSourcePath(
                sourceModFolder, sourcePlugin.Name, document.RecordType, formKey, document.EditorId, release);
            if (File.Exists(fullPath))
                return _codec.DeserializeAsync(fullPath, release, document.RecordType).GetAwaiter().GetResult();

            // Same diagnostic as ReadCopySourceBody's own missing-file branch above.
            logger.LogWarning(
                "Source file {SourcePath} is missing; copying from the indexed document instead", fullPath);
        }

        return _codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body!), release, document.RecordType)
            .GetAwaiter().GetResult();
    }

    /// <summary>The same write-then-rename <see cref="RecordTextCodec.SerializeAsync"/> uses (#412) —
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
    /// #427: a renumber is a delete+create pair in source terms (the source path embeds the FormKey)
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
        if (RefuseIfBlocked(plugin, out var modFolder) is { } blocked) return blocked;

        var index = sessions.Index;
        if (index == null)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No session is loaded.");

        var document = index.GetDocument(formKey, plugin);
        if (document == null)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound, $"{plugin.Name} does not hold record {formKey}.");
        }

        var release = sessions.Session!.GameRelease;

        // #461: the same record→source-unit resolution EditField/DeleteRecord use, replacing the old
        // blanket container refusal — a container's own directory, an embedded child, or a flat
        // record's file all answer here; only "nothing on disk holds this, and the index names no
        // container that would" still refuses.
        if (SourceUnitResolver.Resolve(index, plugin, modFolder, formKey, document.RecordType, document.EditorId, release)
            is null)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.SourceUnitNotFound,
                $"No source file in {plugin.Name}'s tree holds {formKey}, and the index names no container " +
                "that would. Something moved or removed it outside Modbench — check the Source Control panel.");
        }

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
        var referencers = index.GetReferencedBy(formKey)
            .Select(r => (FormKey: r.FormKey, Plugin: new PluginKey(r.Plugin, r.Origin)))
            .Distinct()
            .ToList();

        var untrackedReferencers = referencers
            .Select(r => r.Plugin)
            .Distinct()
            .Where(p => ModFolders.TrackedOf(sessions.Session, p) == null)
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
                var referencerModFolder = ModFolders.TrackedOf(sessions.Session, referencerPlugin)!;
                RewriteReferenceField(index, referencerPlugin, referencerModFolder, referencerFormKey, formKey, targetFormKey, release);
                writtenRepos.Add($"{referencerPlugin.Name} ({referencerPlugin.Origin})");
            }

            RenumberTheRecordItself(index, plugin, modFolder, formKey, targetFormKey, release);
            writtenRepos.Add($"{plugin.Name} ({plugin.Origin})");
        }
        catch (Exception ex)
        {
            // Q5(b): names exactly which repos already carry working-tree dirt from this partial
            // cascade — every one of them is independently reviewable and revertable in the Source
            // Control panel, which is the whole reason write order (referencers first, target last)
            // matters: nothing here is a half-renumbered *target* record, only whichever referencers
            // got as far as this exception. Deliberately unfiltered (not `when (ex is IOException or
            // UnauthorizedAccessException)`): a concurrent external change mid-cascade — another
            // process deleting a referencer between GetReferencedBy and its own rewrite, say — throws
            // RewriteReferenceField's/RenumberTheRecordItself's own InvalidOperationException, and
            // that must carry this same written-repos disclosure rather than silently losing it by
            // falling through this catch to the endpoint's *different* InvalidOperationException
            // handler ("no usable session" — a different question entirely, and a misleading answer
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
            // #422: on both outcomes, not just success — a mid-cascade failure still leaves whatever
            // referencer rewrites already landed (writtenRepos) durably on disk before the throw above,
            // and _filter must not stay stale for those just because the record's own rewrite is what
            // failed. Re-applied once rather than per write — cheaper and no less correct, since
            // SetFilter re-derives the full matching set regardless of how many rows moved since it was
            // last run.
            sessions.ReapplyFilter();
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
    /// <para><b>#461</b>: widened off the flat-only <see cref="SourceUnitResolver.FlatSourcePath"/>
    /// assumption onto full <see cref="SourceUnitResolver.Resolve"/>, so a referencer that is itself a
    /// container or an embedded child (a placed ref's own <c>Base</c> FormLink, say) rewrites cleanly
    /// instead of the whole renumber refusing outright. The string replace still lands on whichever
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
        var referencerDoc = index.GetDocument(referencerFormKey, referencerPlugin)
            ?? throw new InvalidOperationException(
                $"{referencerPlugin.Name} no longer holds {referencerFormKey} mid-renumber.");

        if (SourceUnitResolver.Resolve(
                index, referencerPlugin, referencerModFolder, referencerFormKey, referencerDoc.RecordType,
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
            unit.FullPath, index.GetDocument(unit.OwnerFormKey, referencerPlugin)!, release);
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
    /// rewrote above is reflected in the body this reserializes under the new FormKey. #461: dispatches
    /// on the target's own source unit shape, resolved fresh for the same reason.</summary>
    private void RenumberTheRecordItself(
        IRecordIndex index, PluginKey plugin, string modFolder, string oldFormKey, string newFormKey, GameRelease release)
    {
        var document = index.GetDocument(oldFormKey, plugin)
            ?? throw new InvalidOperationException($"{plugin.Name} no longer holds {oldFormKey} mid-renumber.");
        if (SourceUnitResolver.Resolve(index, plugin, modFolder, oldFormKey, document.RecordType, document.EditorId, release)
            is not { } unit)
        {
            throw new InvalidOperationException($"No source unit in {plugin.Name}'s tree holds {oldFormKey} mid-renumber.");
        }

        if (unit.IsEmbedded)
        {
            RenumberEmbeddedChild(index, plugin, unit, oldFormKey, newFormKey, document.RecordType, release);
            return;
        }

        var record = ReadRecordFromSource(unit.FullPath, document, release);
        ((IMajorRecordInternal)record).FormKey = FormKey.Factory(newFormKey);

        // A container's own directory (Cell/Worldspace/Quest, or a nested folder-split child) versus
        // a flat record's single file — the same distinction DeleteRecord makes, both now reading
        // SourceUnit's own IsDirectoryPerRecord rather than retyping the check.
        var isDirectoryPerRecord = unit.IsDirectoryPerRecord;
        var oldLeafPath = isDirectoryPerRecord ? Path.GetDirectoryName(unit.FullPath)! : unit.FullPath;
        var parentDirectory = Path.GetDirectoryName(oldLeafPath)!;

        // EditorID does not change across a renumber — only the FormKey half of the leaf name does.
        // #459: doc-commented as "a delete+create pair in source terms" — taken literally, the new
        // FormKey's leaf goes at the end of the same parent directory (a fresh next index), the same
        // as an ordinary CreateRecord. #489: the old slot's number is only ever a momentary gap now —
        // the renormalize pass below closes it as this method's own last file-system act, rather than
        // leaving it unfilled.
        var newOrderIndex = SourceUnitResolver.NextOrderIndex(parentDirectory);
        var newLeafName = $"[{newOrderIndex}] " +
            SourceUnitResolver.LeafNameFor(FormKey.Factory(newFormKey), document.EditorId, isDirectoryPerRecord);
        var newLeafPath = Path.Combine(parentDirectory, newLeafName);

        var newBody = _codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();

        if (isDirectoryPerRecord)
        {
            // Moved whole, not recreated from scratch: a container's nested folder-split children (a
            // Quest's own DialogTopics subtree) travel with it rather than being orphaned.
            Directory.Move(oldLeafPath, newLeafPath);
            _codec.SerializeAsync(record, Path.Combine(newLeafPath, SourceUnitResolver.RecordDataFileName), release)
                .GetAwaiter().GetResult();
        }
        else
        {
            Directory.CreateDirectory(parentDirectory);
            _codec.SerializeAsync(record, newLeafPath, release).GetAwaiter().GetResult();
        }

        index.CreateWorkingTreeRecord(plugin, newFormKey, document.RecordType, Encoding.UTF8.GetString(newBody));

        if (!isDirectoryPerRecord && File.Exists(unit.FullPath)) File.Delete(unit.FullPath);

        // #489: this method's own last file-system act — closes the gap the old slot just left (and
        // any pre-existing one besides) so the group directory is contiguous again before this returns.
        SourceUnitResolver.RenormalizeGroupOrder(parentDirectory);

        // #488 review: a folder-split container's own children (a renumbered Quest's DialogTopics, a
        // renumbered DialogTopic's Responses) keep their own FormKeys and their own files untouched —
        // only this record's own directory name changed, moved whole above — so nothing re-derives
        // their container_child rows from a reserialized document the way an embedded child's would
        // be. Re-pointed here, before the old FormKey's own rows are torn down below, so they are
        // never left orphaned even for one transaction. A no-op for a record with no folder-split
        // children of its own (every other renumbered type).
        index.RepointContainerChildParent(plugin, oldFormKey, newFormKey);

        // #493: the mirror gap #488 declined — a renumbered Worldspace's *exterior* cells
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
    /// #461: the embedded half of a renumber — the child's own <c>FormKey</c> field changes in place
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
        var owner = ReadRecordFromSource(unit.FullPath, index.GetDocument(unit.OwnerFormKey, plugin)!, release);

        if (ContainerChildFields.FindEmbeddedChild(owner, oldFormKey) is not { } found)
        {
            throw new InvalidOperationException(
                $"{unit.RelativePath} is indexed as holding {oldFormKey}, but its own text does not carry it mid-renumber.");
        }

        ((IMajorRecordInternal)found.Child).FormKey = FormKey.Factory(newFormKey);

        var newOwnerBody = _codec.SerializeToBytesAsync(owner, release).GetAwaiter().GetResult();
        _codec.SerializeAsync(owner, unit.FullPath, release).GetAwaiter().GetResult();
        var newChildBody = _codec.SerializeToBytesAsync(found.Child, release).GetAwaiter().GetResult();

        index.ApplyWorkingTreeChanges(plugin, [(unit.OwnerFormKey, Encoding.UTF8.GetString(newOwnerBody))]);
        index.CreateWorkingTreeRecord(plugin, newFormKey, childRecordType, Encoding.UTF8.GetString(newChildBody));
        index.ApplyWorkingTreeChanges(plugin, [(oldFormKey, null)]);
    }

    /// <summary>
    /// #427's both-refs collision-safety: <paramref name="formKey"/> must be held at neither
    /// <see cref="RecordRef.Effective"/> nor <see cref="RecordRef.Head"/> — the same rule
    /// <see cref="IRecordIndex.CreateWorkingTreeRecord"/> itself enforces (it throws rather than
    /// silently overwrite), checked here first so a collision reads as a typed refusal instead of an
    /// unhandled exception reaching the endpoint.
    /// </summary>
    private static bool IsFreeAtBothRefs(IRecordIndex index, PluginKey plugin, string formKey) =>
        index.GetDocument(formKey, plugin) == null && index.At(RecordRef.Head).GetDocument(formKey, plugin) == null;

    /// <summary>
    /// #427: the target-FormKey resolution <see cref="CreateRecord"/> and <see cref="RenumberRecord"/>
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
        var mod = sessions.Session!.GetMod(plugin.Name, plugin.Origin!);

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
    /// #427: a caller-typed target FormKey (xEdit's own typed-FormID path, on both create and
    /// renumber) must belong to <paramref name="plugin"/>'s own ModKey — the source path a native
    /// record's FormKey embeds is exactly <paramref name="plugin"/>'s own directory, so a foreign
    /// ModKey would land a record physically inside this plugin's source tree while claiming to
    /// originate somewhere else, which is indistinguishable from a corrupt override once written.
    /// xEdit's own Add/renumber gestures have no way to claim a foreign FormID either — this is not
    /// a new restriction, only this seam refusing to silently accept what the UI never offered.
    /// Reuses <see cref="RecordEditRefusal.NotNativeRecord"/>: both cases are "this operation only
    /// ever touches this plugin's own native FormKey space."
    ///
    /// <para>#501: once a typed target is confirmed native, it must also fit
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
    /// #501: the shared ESL-flagged predicate (<see cref="PluginFlagPredicates.IsLight"/>) both the
    /// typed-target range check and <see cref="NextFreeNativeFormId"/>'s cap need, bridged for the
    /// nullable <paramref name="mod"/> both callers may hold (a session can resolve a
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
    /// <c>SessionManager.SafeNextFormId</c>'s identical floor) when <paramref name="mod"/> is
    /// available, else the conservative literal floor every Bethesda game shares.
    ///
    /// <para>Null means the plugin's FormKey space is exhausted — every local ID up to
    /// <c>0xFFFFFF</c> already in use, or, for a plugin <see cref="IsLightPlugin"/> reports as
    /// ESL-flagged (#501), up to <c>0xFFF</c>: the engine cannot address a higher local ID from a
    /// light plugin's load-order slot, so this allocator can never hand one out regardless of native
    /// space still free above it. A typed refusal at both call sites
    /// (<see cref="RecordEditRefusal.FormKeySpaceExhausted"/>), not an exception: a full plugin
    /// refusing a new record is an ordinary, expected outcome (review finding #1), the same doctrine
    /// as every other refusal on this write path, not a fault for the caller's generic exception
    /// handling to (mis)classify as "no usable session."</para>
    /// </summary>
    private static string? NextFreeNativeFormId(IRecordIndex index, PluginKey plugin, IModGetter? mod)
    {
        var floor = mod?.GetDefaultInitialNextFormID() ?? 0x800u;
        var highest = index.GetNativeFormKeys(plugin)
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
    /// #427: the same both-refs allocator <see cref="CreateRecord"/>/<see cref="RenumberRecord"/> use
    /// internally, exposed read-only so the Renumber gesture's FormID input box can prefill a
    /// suggested value the way xEdit's own "New FormID generated" flow does — never a write, and no
    /// tracked/untracked gate: it is pure arithmetic over already-indexed state, harmless to ask for
    /// a plugin nobody can edit yet.
    ///
    /// <para>Returns the same typed <see cref="RecordEditResult"/> shape every other entry point on
    /// this write path does (review finding #2: brought to the same standard as
    /// <see cref="CreateRecord"/>/<see cref="RenumberRecord"/>, rather than a bespoke nullable-string
    /// contract) — <see cref="RecordEditRefusal.RecordNotFound"/> when no session is loaded (matching
    /// every sibling method's own "No session is loaded." refusal here) and
    /// <see cref="RecordEditRefusal.FormKeySpaceExhausted"/> when the plugin's FormKey space is full;
    /// <see cref="RecordEditResult.NewFormKey"/> carries the suggestion on success.</para>
    /// </summary>
    public RecordEditResult PeekNextFreeFormKey(PluginKey plugin)
    {
        var index = sessions.Index;
        if (index == null)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No session is loaded.");

        var mod = sessions.Session!.GetMod(plugin.Name, plugin.Origin!);
        var formKey = NextFreeNativeFormId(index, plugin, mod);
        return formKey != null
            ? RecordEditResult.Success(formKey)
            : RecordEditResult.Refused(
                RecordEditRefusal.FormKeySpaceExhausted, FormKeySpaceExhaustedMessage(plugin, IsLightPlugin(mod, plugin)));
    }

    /// <summary>
    /// AC3 / ADR-0041: Dangling and Type-Mismatched FormLinks are blocked at edit
    /// time, before anything is written. Returns the diagnostic, or null when the value is clean.
    ///
    /// <para><b>Effective state is what this resolves against</b>, which is what AC3 requires: a
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
    /// <para>The whole field is validated, not only the part that changed — the same scope
    /// <c>ReferenceValidator</c> had before #410, and the only coherent one for a complex field that
    /// is written atomically. This walks the <i>incoming</i> value rather than the applied record so
    /// that what is checked is exactly what the caller asked to create.</para>
    ///
    /// <para>Scope is the reflected columns, matching the pre-#410 validator exactly. VMAD Object
    /// properties and condition Form parameters carry FormKeys too and are not checked here; they
    /// were not checked before either, and widening that is its own change with its own evidence.</para>
    /// </summary>
    private static string? ValidateFormLinks(
        IRecordIndex index,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        string recordType,
        string fieldPath,
        JsonElement value)
    {
        if (!schemas.TryGetValue(recordType, out var schema)) return null;
        var col = schema.RecordColumns.FirstOrDefault(c => c.Name == fieldPath);
        if (col == null) return null;

        // The same builder the read model renders check errors from, so "what the editor flags in a
        // loaded plugin" and "what the editor refuses to create" are one definition of a broken link,
        // not two that can drift.
        return CheckErrorBuilder.Build(col.ToFieldMetadata(), value, index.Resolve);
    }

    /// <summary>The Track command as the palette actually shows it — <c>package.json</c>'s title
    /// ("Track…", U+2026) under its category ("Modbench"). One constant, because a signpost naming
    /// a command the user cannot find is worse than no signpost at all.</summary>
    internal const string TrackCommandTitle = "Modbench: Track\u2026";

    /// <summary>
    /// The two refusals every entry point on this single write path must inherit, in order \u2014
    /// untracked (AC4), then #417 exit path 3's external-change deferral \u2014 checked here once so
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
        if (ModFolders.TrackedOf(sessions.Session, plugin) is not { } folder)
        {
            modFolder = "";
            return RefuseUntracked(plugin);
        }
        modFolder = folder;

        // #417 exit path 3: a same-plugin external-change question left unanswered refuses every
        // gesture on the single write path \u2014 checked before anything else, so neither of the write
        // path's two doors fires: the source file is never touched, and the index call that would
        // tell the DB about it is never reached.
        return ExternalChangeDeferral.Pending(folder, plugin.Name) is { } pendingQuestion
            ? RecordEditResult.Refused(RecordEditRefusal.ExternalChangePending, pendingQuestion)
            : null;
    }

    // AC4: two refusals, because there are two different ways out and a message that named neither
    // would be the "silent dead UI" this ticket exists to avoid.
    private RecordEditResult RefuseUntracked(PluginKey plugin) =>
        ModFolders.Of(sessions.Session, plugin) is null
            ? RecordEditResult.Refused(
                RecordEditRefusal.PluginHasNoModFolder,
                $"{plugin.Name} is a base-game plugin with no mod folder, so it cannot be tracked. " +
                "Author a patch plugin and edit the override there.")
            : RecordEditResult.Refused(
                RecordEditRefusal.PluginNotTracked,
                $"{plugin.Name} is not tracked, so it is read-only. " +
                // The palette entry verbatim: package.json contributes title "Track…" under
                // category "Modbench", which VS Code renders as "Modbench: Track…". Naming a
                // command that does not exist is the same dead end AC4 exists to prevent, so the
                // tests assert this string exactly rather than merely containing "Track".
                $"Run \"{TrackCommandTitle}\" on it once to start editing.");

    private static RecordEditResult RefuseFieldOutcome(
        FieldApplyOutcome outcome, string fieldPath, string recordType,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (outcome == FieldApplyOutcome.ReadOnly)
            return RecordEditResult.Refused(RecordEditRefusal.FieldReadOnly, $"'{fieldPath}' is read-only.");

        // #531 named this its own outcome; #532 made answering it directly (rather than inferring it
        // one layer up from "a rejection whose value happens to be a genuine JSON array") load-bearing
        // — a well-typed element's own declined sub-field value is now a second way to reach exactly
        // that shape, which the old heuristic could not tell apart from an unresolved element type.
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

        return RecordEditResult.Refused(RecordEditRefusal.FieldNotFound, $"'{recordType}' has no field '{fieldPath}'.");
    }

    /// <summary>
    /// #503: names the field and the JSON shape it takes. A complex field is written as one atomic
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
    /// <para><b>#461: <see cref="DeleteRecord"/> and <see cref="RenumberRecord"/> are no longer among
    /// them.</b> Both now resolve through <see cref="SourceUnitResolver"/> instead — the same
    /// resolution <see cref="EditField"/> already used (#453) — because deleting or renumbering a
    /// container's own record, or an embedded child, is mechanical (move/remove a known file, or splice
    /// a known slot) the moment the record→source-unit question has an answer. Only
    /// <see cref="CreateRecord"/> is left refusing this shape: a brand-new record has no containment
    /// for anything to resolve <i>to</i> yet, and choosing one is a UX decision (#462), not a mechanical
    /// one.</para>
    ///
    /// <para>Note the condition is wider than "Cell, Worldspace or Quest", which is what this message
    /// used to claim (#453 finding): <see cref="RecordTypeDispatch.FolderNameFor"/> is also null for
    /// every record with no top-level group of its own — placed references, landscapes, navmeshes,
    /// dialog topics, scenes. The message now names what actually triggers it.</para>
    /// </summary>
    private static RecordEditResult? RefuseIfContainerType(string recordType, GameRelease release)
    {
        if (RecordTypeDispatch.For(release).FolderNameFor(recordType) is not null) return null;

        return RecordEditResult.Refused(
            RecordEditRefusal.ContainerRecordNotYetSupported,
            $"'{recordType}' has no source file of its own — it is a container record (Cell, Worldspace, " +
            "Quest) or a record embedded in one (a placed reference, landscape, navmesh, dialog topic, " +
            "scene). Editing its fields works, and so do deleting and renumbering it; creating one from " +
            "scratch does not yet (#462) — a brand-new record has no containment for anything to place " +
            "it into.");
    }

    /// <summary>
    /// #440 Slice 8: <see cref="CopyRecordAsNewRecord"/>'s own permanent blacklist — xEdit itself
    /// refuses Copy as New Record for CELL/WRLD/LAND/NAVM/PGRD/ROAD/NAVI, in both its UI and its
    /// engine, because a fresh FormKey would leave the copy structurally homeless: a container's
    /// children only exist in a plugin that also carries the container, and duplicating the container
    /// itself under a new identity does not create a group for a copy to sit in. Only <c>cell</c>/
    /// <c>wrld</c> are checked by name here — the other five have no schema table at all
    /// (<see cref="ISchemaReflector"/> does not surface Landscape/NavigationMesh etc. as record types),
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
    /// #440: <see cref="CopyRecordAsOverride"/>'s own container gate — narrower than
    /// <see cref="RefuseIfContainerType"/>, which <see cref="CreateRecord"/> keeps unchanged. A
    /// container's own top-level record (Cell, Worldspace, Quest) has somewhere to land — its own
    /// directory, minted the same way any other structural write's group folder is — so only a record
    /// with no container of its own anywhere in the tree still refuses here: an embedded child (a
    /// placed reference, a landscape, a navmesh) or a folder-split child with no independent top-level
    /// existence (a dialog topic, a scene, a response). That is a different question from
    /// <see cref="CreateRecord"/>'s own reason to refuse every container type — a brand-new record has
    /// no containment for anything to resolve to yet (#462) — which is why the two gestures use
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
    /// #440: the destination path for a directory-per-record container's own top-level record —
    /// Worldspace or Quest, whose directory sits directly under its own group folder with no further
    /// nesting (verified against a real Track output: <c>Worldspaces/[0] &lt;name&gt;/RecordData.json</c>).
    /// Cell is deliberately not handled here: its directory nests under an interior block/sub-block
    /// path (or an exterior worldspace one, #549's own scope), which this simple "next index in one
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
    /// #440 Slices 2/7: the destination path for an interior Cell — the one directory-per-record type
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
    private static string InteriorCellDestinationPath(
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

    // #440 review (Standards 2): matches Track's own JsonSerializer.SerializeToUtf8Bytes shape
    // (WriteIndented) — the one setting that matters for this method's own byte-exact-match contract,
    // see its doc comment.
    private static readonly JsonSerializerOptions GroupRecordDataOptions = new() { WriteIndented = true };

    /// <summary>
    /// A GRUP's own tiny metadata file — never a "record" the codec has a schema for, so this writes
    /// the JSON directly rather than through <see cref="RecordTextCodec"/>. <paramref name="groupType"/>
    /// null writes <c>{}</c> (the top-level Cells group's own shape); otherwise
    /// <c>{"GroupType": "&lt;value&gt;"}</c> — <c>BlockNumber</c> is always omitted here because every
    /// group this method mints is numbered <c>0</c>, and a real Track output omits a
    /// <c>BlockNumber</c> of exactly <c>0</c> rather than writing the literal.
    ///
    /// <para>#440 review (Standards 2): a real Track output pretty-prints this file (2-space indent,
    /// multi-line) through <c>System.Text.Json</c>'s own default writer, not the single-line JSON this
    /// method used to hand-write — two block folders in the same tree ending up differently formatted
    /// is exactly what trips up byte-compare tooling (#475's own parked fixed-point-check concern).
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
    /// #440 AC3: deserializes <paramref name="body"/>, clears every child-major slot
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
    private IMajorRecord ReadRecordFromSource(string sourcePath, RecordDocument document, GameRelease release)
    {
        // #450: both reads state the record's type rather than relying on the document to name it —
        // the same document either way, so the same record_type identifies it either way.
        if (File.Exists(sourcePath))
            return _codec.DeserializeAsync(sourcePath, release, document.RecordType).GetAwaiter().GetResult();

        logger.LogWarning(
            "Source file {SourcePath} is missing; editing from the indexed document and rewriting it", sourcePath);
        return _codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body!), release, document.RecordType)
            .GetAwaiter().GetResult();
    }
}
