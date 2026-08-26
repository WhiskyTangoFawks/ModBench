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

        if (ValidateFormLinks(index, schemas, document.RecordType, fieldPath, value) is { } linkError)
            return RecordEditResult.Refused(RecordEditRefusal.InvalidFormLink, linkError);

        var outcome = RecordFieldWriter.TryApply(target, document.RecordType, fieldPath, value, schemas, release);
        if (outcome != FieldApplyOutcome.Applied)
            return RefuseFieldOutcome(outcome, fieldPath, document.RecordType);

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

        logger.LogInformation(
            "Edited {FieldPath} on {FormKey} in {Plugin} ({Origin}) — working-tree change written to {SourcePath}",
            fieldPath, formKey, plugin.Name, plugin.Origin, unit.RelativePath);
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
    /// per-table.</b> <c>placement</c>'s only non-containment columns come from <c>Position</c>, a
    /// <c>P3Float</c> the schema reflector does not map at all — verified, not assumed: it never
    /// becomes a column, so <see cref="RecordFieldWriter"/> answers <c>FieldNotFound</c> for it and no
    /// edit can move a placed reference. <c>cell_location</c>'s only non-containment columns are the
    /// grid, refused here. <c>container_child</c> is containment and slot order throughout, and the
    /// slots that could change it are refused here too. So after this guard, every side table is
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
            logger.LogInformation(
                "EditorID changed on {FormKey}; moved its source directory {Old} to {New}",
                edited.FormKey, Path.GetFileName(oldLeafPath), Path.GetFileName(newLeafPath));
            return Path.Combine(newLeafPath, SourceUnitResolver.RecordDataFileName);
        }

        File.Move(oldLeafPath, newLeafPath, overwrite: true);
        logger.LogInformation(
            "EditorID changed on {FormKey}; moved its source file {Old} to {New}",
            edited.FormKey, Path.GetFileName(oldLeafPath), Path.GetFileName(newLeafPath));
        return newLeafPath;
    }

    /// <summary>
    /// #427: deletes one plugin's copy of <paramref name="formKey"/> as a working-tree change — the
    /// source file goes away, and <see cref="IRecordIndex.ApplyWorkingTreeChanges"/>'s null-Body case
    /// (the mechanism #415 landed and tested in both flip directions) takes it from there: gone at
    /// Effective, still served at Head until this is committed and compiled. No reference cascade —
    /// a FormLink elsewhere pointing at the deleted record goes dangling and surfaces as an ordinary
    /// compile diagnostic, exactly like any other dangling link (ADR-0020).
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

        logger.LogInformation(
            "Deleted {FormKey} from {Plugin} ({Origin}) — working-tree deletion of {SourcePath} ({Count} index row(s) removed)",
            formKey, plugin.Name, plugin.Origin, unit.RelativePath, deltas.Count);
        return RecordEditResult.Success();
    }

    /// <summary>
    /// #461: every descendant <paramref name="formKey"/> holds, recursively — a Cell's placed refs
    /// (<see cref="IRecordReads.GetCellReferences"/>), a Worldspace's TopCell
    /// (<see cref="IRecordReads.GetWorldspaceCells"/>, the row with no block coordinates) and
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

        var topCell = reads.GetWorldspaceCells(plugin, formKey).FirstOrDefault(c => c.BlockX == null);
        var topCellDescendants = topCell == null
            ? Enumerable.Empty<string>()
            : WithDescendants(reads, plugin, topCell.FormKey);

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

        logger.LogInformation(
            "Created {RecordType} {FormKey} in {Plugin} ({Origin}) — new working-tree source file at {SourcePath}",
            recordType, targetFormKey, plugin.Name, plugin.Origin, relativePath);
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
        if (RefuseIfContainerType(document.RecordType, release) is { } containerRefusal) return containerRefusal;

        if (!IsFreeAtBothRefs(index, destinationPlugin, formKey))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{formKey} is already held by a record in {destinationPlugin.Name} at some ref.");
        }

        var body = ReadCopySourceBody(sourcePlugin, formKey, document, release);

        // Same shape as CreateRecord's own write: next order index in the destination's own group
        // folder for this record type, a brand-new file there, and the same #489 renormalize pass as
        // this method's own last file-system act.
        var orderIndex = SourceUnitResolver.NextOrderIndexFor(destinationModFolder, destinationPlugin.Name, document.RecordType, release);
        var relativePath = SourceRecordPath.For(destinationPlugin.Name, document.RecordType, formKey, document.EditorId, release, orderIndex);
        var sourcePath = Path.Combine(destinationModFolder, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(sourcePath)!);

        WriteBodyAtomic(sourcePath, body);

        SourceUnitResolver.RenormalizeGroupOrder(Path.GetDirectoryName(sourcePath)!);

        index.CreateWorkingTreeRecord(destinationPlugin, formKey, document.RecordType, body);
        // #422: a brand-new row can newly match an active filter.
        sessions.ReapplyFilter();

        logger.LogInformation(
            "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
            "({DestinationOrigin}) — new working-tree source file at {SourcePath}",
            formKey, sourcePlugin.Name, sourcePlugin.Origin, destinationPlugin.Name, destinationPlugin.Origin, relativePath);
        return RecordEditResult.Success(formKey);
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

        logger.LogInformation(
            "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as new record {NewFormKey} into " +
            "{DestinationPlugin} ({DestinationOrigin}) — new working-tree source file at {SourcePath}",
            formKey, sourcePlugin.Name, sourcePlugin.Origin, targetFormKey, destinationPlugin.Name,
            destinationPlugin.Origin, relativePath);
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
            return ReadRecordFromSource(fullPath, document, release);
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

        logger.LogInformation(
            "Renumbered {OldFormKey} to {NewFormKey} in {Plugin} ({Origin}), rewriting {Count} referencing record(s)",
            formKey, targetFormKey, plugin.Name, plugin.Origin, referencers.Count);
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
        if (requestedFormKey != null)
        {
            if (RefuseIfNotNativeTarget(requestedFormKey, plugin) is { } notNative)
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

        var allocated = NextFreeNativeFormId(index, plugin, sessions.Session!.GetMod(plugin.Name, plugin.Origin!));
        if (allocated != null)
        {
            targetFormKey = allocated;
            return null;
        }

        targetFormKey = "";
        return RecordEditResult.Refused(RecordEditRefusal.FormKeySpaceExhausted, FormKeySpaceExhaustedMessage(plugin));
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
    /// </summary>
    private static RecordEditResult? RefuseIfNotNativeTarget(string requestedFormKey, PluginKey plugin)
    {
        var requestedOwner = FormKey.Factory(requestedFormKey).ModKey.FileName.String;
        if (requestedOwner.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase)) return null;

        return RecordEditResult.Refused(
            RecordEditRefusal.NotNativeRecord,
            $"{requestedFormKey} belongs to {requestedOwner}, not {plugin.Name} — a requested FormKey " +
            "must be native to the plugin it is being created or renumbered into.");
    }

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
    /// <para>Null means the plugin's FormKey space is exhausted (every local ID up to
    /// <c>0xFFFFFF</c> already in use) — a typed refusal at both call sites
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
        return next > 0xFFFFFF ? null : $"{next:X6}:{plugin.Name}";
    }

    private static string FormKeySpaceExhaustedMessage(PluginKey plugin) =>
        $"{plugin.Name} has exhausted its FormKey space — every local FormID up to 0xFFFFFF is already in use.";

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

        var formKey = NextFreeNativeFormId(index, plugin, sessions.Session!.GetMod(plugin.Name, plugin.Origin!));
        return formKey != null
            ? RecordEditResult.Success(formKey)
            : RecordEditResult.Refused(RecordEditRefusal.FormKeySpaceExhausted, FormKeySpaceExhaustedMessage(plugin));
    }

    /// <summary>
    /// AC3 / ADR-0020 (kept, relocated): Dangling and Type-Mismatched FormLinks are blocked at edit
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

    private static RecordEditResult RefuseFieldOutcome(FieldApplyOutcome outcome, string fieldPath, string recordType) =>
        outcome == FieldApplyOutcome.ReadOnly
            ? RecordEditResult.Refused(RecordEditRefusal.FieldReadOnly, $"'{fieldPath}' is read-only.")
            : RecordEditResult.Refused(RecordEditRefusal.FieldNotFound, $"'{recordType}' has no field '{fieldPath}'.");

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
