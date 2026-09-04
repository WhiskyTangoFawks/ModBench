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

/// <summary>The single write path (ADR-0041): a field edit on a tracked plugin becomes a working-tree
/// change to the record's source JSON. The source text is the source, not the index; every
/// refusal precedes any write.</summary>
public sealed class RecordEditService(
    ILoadOrderMirror mirror,
    SchemaReflector schemaReflector,
    ILogger<RecordEditService> logger)
{
    private readonly RecordTextCodec _codec = new(Microsoft.Extensions.Logging.Abstractions.NullLogger<RecordTextCodec>.Instance);

    // RecordCopy shares this instance's mirror/schemaReflector so its writes are indistinguishable
    // from this class's own (ADR-0041's one write path). A field initializer cannot reference
    // _codec, hence the second codec instance.
    private readonly RecordCopy _recordCopy = new(
        mirror, schemaReflector, logger, new RecordTextCodec(Microsoft.Extensions.Logging.Abstractions.NullLogger<RecordTextCodec>.Instance));

    /// <summary>Complex fields arrive as one whole value (CONTEXT.md's atomic field-level write);
    /// <see cref="RecordFieldWriter"/> dispatches.</summary>
    public RecordEditResult EditField(PluginKey plugin, string formKey, string fieldPath, JsonElement value)
    {
        if (ResolveEditTarget(plugin, formKey, out var editTarget) is { } blocked) return blocked;
        var (index, _, release, document, unit) = editTarget;
        var schemas = schemaReflector.GetSchemas(release);

        // A ModHeader is not an IMajorRecord, so it cannot flow through the generic per-record
        // pipeline below; answered off the schema alone.
        if (document.RecordType == HeaderIndexer.RecordType)
        {
            // The ESL flag's one sanctioned door, the same pattern is_partial_form uses. Every real
            // header column still refuses.
            if (fieldPath.Equals(IsLightFieldPath, StringComparison.Ordinal))
                return EditHeaderIsLight(index, plugin, unit, formKey, value);
            return RefuseHeaderFieldEdit(fieldPath, schemas);
        }

        var reads = index.At(RecordRef.Effective);
        var owner = reads.GetDocument(unit.OwnerFormKey, plugin)!;
        var record = ReadRecordFromSource(_codec, logger, unit.FullPath, owner, release);

        // The target may be inside `record` (an embedded child). Locating it in the parent's object
        // graph keeps it on the same machinery: reserializing the parent writes it back with every
        // untouched byte intact.
        var target = record;
        if (unit.IsEmbedded)
        {
            if (ContainerChildFields.FindEmbeddedChild(record, formKey) is not { } found)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    // Deliberately does not blame an external change: a defect reads identically, and a
                    // wrong explanation sends the user hunting a problem that is not there.
                    $"{unit.RelativePath} is indexed as holding {formKey}, but its own text does not " +
                    "carry it. If nothing outside Modbench changed that file, this is a defect — please " +
                    "report it; otherwise relaunch mEdit so the index re-reads the tree.");
            }
            target = found.Child;
        }

        if (RefuseIfContainmentField(document.RecordType, fieldPath, schemas, release) is { } containmentRefusal)
            return containmentRefusal;

        // Checked against `target`, not `record`, so an embedded child of a Partial Form override is
        // unaffected (CONTEXT.md). EditorID is exempt: xEdit's CanAssignInternal allows it (ADR-0034).
        // is_partial_form is exempt: clearing it is the only way out.
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

        // Reflected flag columns alias the MajorRecordFlagsRaw int bit 14 lives in. Checked
        // structurally rather than by column name, which would miss the next game's alias; the
        // mutated record is a throwaway, so a caught leak leaves the tree untouched.
        var checkBit14Leak = !fieldPath.Equals(RecordFieldWriter.IsPartialFormFieldPath, StringComparison.Ordinal)
            && PartialFormFlag.IsPartialFormable(target.GetType());
        var bit14Before = checkBit14Leak ? target.MajorRecordFlagsRaw & PartialFormFlag.Bit : 0;

        var applied = RecordFieldWriter.TryApply(target, document.RecordType, fieldPath, value, schemas);
        // A boundary array op is already satisfied: returned before every write so it leaves no
        // dirty file or history entry.
        if (applied.Outcome == FieldApplyOutcome.NoOp)
            return RecordEditResult.Success();
        if (applied.Outcome != FieldApplyOutcome.Applied)
            return RefuseFieldOutcome(applied, fieldPath, document.RecordType, schemas, value.ValueKind);

        if (checkBit14Leak && (target.MajorRecordFlagsRaw & PartialFormFlag.Bit) != bit14Before)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.PartialFormFlagIndirectWrite,
                $"'{fieldPath}' would change record header flag bit 14 (Partial Form) as a side " +
                "effect of writing an unrelated column. That bit is only writable through " +
                "'is_partial_form' — nothing was written.");
        }

        // The file name carries the EditorID, so an EditorID edit is a rename too. Done before the
        // write: see RenameSourceUnit.
        var sourcePath = RenameSourceUnit(unit, target, document);

        // The atomic write matters here: the file is inside a live git working tree the SCM panel may
        // read at any moment.
        var newBody = SerializeAndWrite(_codec, record, sourcePath, release);

        // An embedded edit dirties two rows, the parent unit and the child's own document, landed in
        // one transaction.
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

    // Reflection makes a container's child slots and Cell.Grid/placed Position ordinary writable
    // columns; writing one would silently desynchronize the cell_location/container_child/placement
    // side tables, which nothing on this path re-derives. Containment is the path (ADR-0041).
    private static RecordEditResult? RefuseIfContainmentField(
        string recordType, string fieldPath, IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release)
    {
        if (!schemas.TryGetValue(recordType, out var schema)) return null;
        if (schema.RecordColumns.FirstOrDefault(c => c.Name == fieldPath) is not { } column) return null;
        if (RecordTypeDispatch.For(release).ConcreteFor(recordType) is not { } concrete) return null;

        // The schema column's own property name, so this guard and the reflector cannot disagree.
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

        // Resolved through the game's own IPlacedGetter marker, not a hardcoded type list, so this
        // holds for whichever types a game module gives Position to.
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

    // Move first, then write: a crash between leaves the file at its new name with old content, valid
    // and still findable via FlatSourcePath's FormKey-suffix fallback. The reverse order leaves two
    // files claiming one FormKey, which AmbiguousSourceUnitException refuses.
    private string RenameSourceUnit(SourceUnit unit, IMajorRecord edited, RecordDocument document)
    {
        // An embedded child's EditorID appears in no path: the file belongs to its parent, whose own
        // EditorID this edit did not touch. Nothing to move.
        if (unit.IsEmbedded) return unit.FullPath;
        if (string.Equals(edited.EditorID, document.EditorId, StringComparison.Ordinal)) return unit.FullPath;

        var isDirectoryPerRecord = unit.IsDirectoryPerRecord;
        var oldLeafPath = isDirectoryPerRecord ? Path.GetDirectoryName(unit.FullPath)! : unit.FullPath;

        // Order lives in the parent's ordered child list keyed by FormKey (ADR-0042 decision 4), which
        // a rename does not change, so no sibling or parent document is touched.
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

    /// <summary>A working-tree deletion: gone at Effective, still served at Head until compiled. No
    /// reference cascade; a dangling FormLink surfaces as an ordinary compile diagnostic (ADR-0041).
    /// Every record shape resolves through <see cref="SourceUnitResolver"/>.</summary>
    public RecordEditResult DeleteRecord(PluginKey plugin, string formKey)
    {
        if (ResolveEditTarget(plugin, formKey, out var target) is { } blocked) return blocked;
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
                // Same diagnosis as EditField's embedded lookup: states only what is observed.
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
            // Captured before anything moves: SlotIndex mirrors the parent's ordered list, and the
            // survivors are re-based the same way the list closes up below. Null for a top-level record.
            var parentLink = reads.GetContainerParent(plugin, formKey);

            // The unit may already be gone (another tool, a hand delete): that is the state this call
            // is trying to reach, not a failure.
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

            // One line leaves one document (ADR-0042 decision 4): no sibling is renamed, so a mid-list
            // delete stages as one deletion plus one changed parent.
            SourceChildOrder.RemoveByIdentity(groupDirectory, formKey);

            // container_child's copy of the same renumbering: the deleted row simply is not among the
            // survivors.
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

        // A container's delete removes its directory whole and an embedded child can have descendants
        // of its own; every descendant's row is nulled in the one batch.
        deltas.Add((formKey, null));
        foreach (var descendant in EnumerateDescendantFormKeys(reads, plugin, formKey))
            deltas.Add((descendant, null));

        index.ApplyWorkingTreeChanges(plugin, deltas);
        // A deleted row cannot match an active filter.
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Deleted {FormKey} from {Plugin} ({Origin}) — working-tree deletion of {SourcePath} ({Count} index row(s) removed)",
                formKey, plugin.Name, plugin.Origin, unit.RelativePath, deltas.Count);
        }
        return RecordEditResult.Success();
    }

    // Index-derived, not object-graph-derived: the per-record codec never populates a folder-split
    // child onto the parent it reads; only the whole-mod door does. Answers empty for a childless
    // FormKey, so DeleteRecord calls it unconditionally.
    private static IEnumerable<string> EnumerateDescendantFormKeys(IRecordReads reads, PluginKey plugin, string formKey)
    {
        var refs = reads.GetCellReferences(plugin, formKey);
        var placedDescendants = refs.Persistent.Concat(refs.Temporary)
            .SelectMany(placed => WithDescendants(reads, plugin, placed.FormKey));

        // Every block-less row, not just the first: a worldspace should carry one TopCell, but the
        // data cannot rule out a second, and stopping at the first would orphan its descendants.
        var topCellDescendants = reads.GetWorldspaceCells(plugin, formKey)
            .Where(c => c.BlockX == null)
            .SelectMany(topCell => WithDescendants(reads, plugin, topCell.FormKey));

        var childDescendants = reads.GetContainerChildren(plugin, formKey)
            .SelectMany(child => WithDescendants(reads, plugin, child.ChildFormKey));

        return placedDescendants.Concat(topCellDescendants).Concat(childDescendants);
    }

    private static IEnumerable<string> WithDescendants(IRecordReads reads, PluginKey plugin, string formKey) =>
        new[] { formKey }.Concat(EnumerateDescendantFormKeys(reads, plugin, formKey));

    /// <summary>The FormKey is <paramref name="requestedFormKey"/> (xEdit's typed-FormID path) or the next
    /// free local ID, collision-checked at both refs so an uncompiled create or a working-tree-deleted
    /// record is never handed out twice.</summary>
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

        // Mutagen's generic factory: every generated major-record type's (FormKey, GameRelease)
        // constructor is private precisely so this is the supported way in.
        var record = MajorRecordInstantiator.Activator(FormKey.Factory(targetFormKey), release, schema.RecordType);
        if (!string.IsNullOrWhiteSpace(editorId)) record.EditorID = editorId;

        // RefuseIfContainerType guarantees a flat record, so no block path. The group folder is minted
        // by the write itself when the plugin has never held this type.
        var placement = SourcePlacement.For(plugin.Name, recordType, targetFormKey, record.EditorID, release);
        var relativePath = placement.RelativePath;
        var newBody = WritePlaced(modFolder, placement, targetFormKey, path => SerializeAndWrite(_codec, record, path, release));

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

    /// <summary>xEdit's "Copy as Override Into…" (ADR-0041): the bytes land verbatim under the same
    /// FormKey, since <see cref="RecordDocument.Body"/> is byte-identical to the source file. The
    /// master dependency is derived at compile (ADR-0038).</summary>
    public RecordEditResult CopyRecordAsOverride(PluginKey sourcePlugin, string formKey, PluginKey destinationPlugin)
    {
        if (ResolveCopySource(destinationPlugin, sourcePlugin, formKey, out var source) is { } blocked) return blocked;
        var (index, destinationModFolder, release, document) = source;
        if (RefuseIfUnderride(formKey, destinationPlugin) is { } underrideRefusal) return underrideRefusal;
        var reads = index.At(RecordRef.Effective);

        // A placed reference has parent-chain-aware handling; GetPlacement answering is what
        // distinguishes it from the embedded types the blanket refusal below still refuses.
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
            // A destination already overriding the explicitly-selected container record gets it
            // replaced, own-fields-only (xEdit's copy-into behavior). Flat records still refuse, as
            // does a record held only at Head.
            if (!isFlat && reads.GetDocument(formKey, destinationPlugin) is { } existingTarget)
            {
                return ReplaceExplicitContainerCopyTarget(
                    index, sourcePlugin, formKey, document, existingTarget, destinationPlugin, destinationModFolder, release);
            }
            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{formKey} is already held by a record in {destinationPlugin.Name} at some ref.");
        }

        // IsInterior is false for both a genuine SubCells cell and a Worldspace's TopCell
        // (PlacementWalker hardcodes it). Only the SubCells case has block coordinates to mint from; a
        // TopCell falls through to the refusal, its placement being a follow-up.
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
            // A plain Copy as Override is own-fields-only, so a container's inline children are
            // stripped. A no-op for Quest, whose children are folder-split.
            body = StripEmbeddedChildrenForShallowCopy(body, document.RecordType, release);
        }

        // A Cell's block bucket is the one thing resolved first, because it is chosen (or minted)
        // rather than derived.
        var destination = SourcePlacement.For(
            destinationPlugin.Name, document.RecordType, formKey, document.EditorId, release,
            isCell ? EnsureInteriorCellBlockPath(destinationModFolder, destinationPlugin.Name, release) : null);
        var relativePath = destination.RelativePath;
        WritePlaced(destinationModFolder, destination, formKey, path =>
        {
            WriteBodyAtomic(path, body);
            return body;
        });

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
        // An override echoes the caller's own FormKey back, so NewFormKey stays null.
        return RecordEditResult.Success();
    }

    /// <summary>xEdit's "Copy as New Record Into…" (ADR-0041): a Mutagen <c>Duplicate</c> under a fresh
    /// FormKey, sharing <see cref="ResolveTargetFormKey"/> with create. A self-link is remapped onto the
    /// new FormKey, as xEdit does.</summary>
    public RecordEditResult CopyRecordAsNewRecord(
        PluginKey sourcePlugin, string formKey, PluginKey destinationPlugin, string? requestedFormKey = null)
    {
        if (ResolveCopySource(destinationPlugin, sourcePlugin, formKey, out var source) is { } blocked) return blocked;
        var (index, destinationModFolder, release, document) = source;
        if (RefuseIfDisallowedForCopyAsNewRecord(document.RecordType) is { } disallowedRefusal) return disallowedRefusal;

        // The QUST/DIAL/INFO family copies as new (xEdit allows exactly these); everything else
        // non-flat still refuses.
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

        // Own-record-only, like Copy as Override: folder-split children never ride along (deep copy
        // is #551's gesture).
        var placement = SourcePlacement.For(
            destinationPlugin.Name, document.RecordType, targetFormKey, newRecord.EditorID, release);
        var relativePath = placement.RelativePath;
        var newBody = WritePlaced(
            destinationModFolder, placement, targetFormKey, path => SerializeAndWrite(_codec, newRecord, path, release));

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

    // The destination's embedded children are transplanted onto the replacing record so the copy
    // cannot delete them; folder-split children have their own files. An EditorID difference renames
    // the unit, since the round-trip gate regenerates canonical names.
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

    // Links between copied siblings are deliberately not remapped: a copied response naming its
    // sibling keeps naming the original, xEdit's own behavior (#440).
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

        // The slot folder is minted by the topic's own write, so it is unminted with it if that
        // write fails (#675).
        var topicRecord = ReadCopySourceRecord(sourcePlugin, formKey, document, release)
            .Duplicate(FormKey.Factory(targetFormKey));
        if (topicRecord is IFormLinkContainer selfLinking)
        {
            selfLinking.RemapLinks(new Dictionary<FormKey, FormKey> { [FormKey.Factory(formKey)] = FormKey.Factory(targetFormKey) });
        }
        var topicPlacement = SourcePlacement.ForSlotChild(
            destinationModFolder, questDirectory, parentQuest.SlotName, targetFormKey, topicRecord.EditorID, isDirectory: true);
        var topicDirectory = Path.GetDirectoryName(Path.Combine(destinationModFolder, topicPlacement.RelativePath))!;
        var topicBody = WritePlaced(
            destinationModFolder, topicPlacement, targetFormKey, path => SerializeAndWrite(_codec, topicRecord, path, release));
        index.CreateWorkingTreeRecord(destinationPlugin, targetFormKey, document.RecordType, topicBody);

        // The topic's own membership in the quest's slot, appended at the end.
        AppendChildToSlot(
            index, reads, destinationPlugin, parentQuest.ParentFormKey, parentQuest.ParentRecordType,
            parentQuest.SlotName, targetFormKey);

        // Allocation and row-creation interleave so the next-free scan always sees the key the
        // previous child just took.
        var copiedChildren = new List<(string ChildFormKey, int SlotIndex)>();
        foreach (var child in reads.GetContainerChildren(sourcePlugin, formKey).OrderBy(c => c.SlotIndex))
        {
            var childDocument = reads.GetDocument(child.ChildFormKey, sourcePlugin)
                ?? throw new InvalidOperationException(
                    $"{sourcePlugin.Name}'s index names {child.ChildFormKey} as a child of {formKey} but holds no document for it.");
            if (ResolveTargetFormKey(index, destinationPlugin, requestedFormKey: null, out var childFormKey) is { } childRefused)
            {
                // The topic and earlier responses are already written, so a Refused here would hide
                // partial state; a fault after writes is an exception carrying the disclosure.
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

            // Source order: the new topic's own document says where its responses sit.
            var childPlacement = SourcePlacement.ForSlotChild(
                destinationModFolder, topicDirectory, child.SlotName, childFormKey, childRecord.EditorID, isDirectory: false);
            var childBody = WritePlaced(
                destinationModFolder, childPlacement, childFormKey, path => SerializeAndWrite(_codec, childRecord, path, release));
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

    // The missing ancestor chain (topic, then its quest) auto-creates bare and Partial Form.
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

        var newRecord = ReadCopySourceRecord(sourcePlugin, formKey, document, release)
            .Duplicate(FormKey.Factory(targetFormKey));
        if (newRecord is IFormLinkContainer selfLinking)
        {
            selfLinking.RemapLinks(new Dictionary<FormKey, FormKey> { [FormKey.Factory(formKey)] = FormKey.Factory(targetFormKey) });
        }

        // The slot folder is minted by the response's own write, not ahead of it (#675).
        var placement = SourcePlacement.ForSlotChild(
            destinationModFolder, topicDirectory, parentTopic.SlotName, targetFormKey, newRecord.EditorID, isDirectory: false);
        var newBody = WritePlaced(
            destinationModFolder, placement, targetFormKey, path => SerializeAndWrite(_codec, newRecord, path, release));
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

    // A missing ancestor auto-creates bare and Partial Form, recursing for a folder-split ancestor's
    // own parent. Overrides keep their original FormKeys; only the copied record draws a fresh one.
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

        SourcePlacement placement;
        ContainerChildRow? ownParent = null;
        if (RecordTypeDispatch.For(release).GroupFolderNameFor(ancestorRecordType) is not null)
        {
            // A top-level container (Quest): its own directory in the group folder, listed by the group.
            placement = SourcePlacement.For(destinationPlugin.Name, ancestorRecordType, ancestorFormKey, editorId: null, release);
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
            placement = SourcePlacement.ForSlotChild(
                destinationModFolder, parentDirectory, ownParent.Value.SlotName, ancestorFormKey, editorId: null, isDirectory: true);
        }

        var recordDataPath = Path.Combine(destinationModFolder, placement.RelativePath);
        var body = WritePlaced(destinationModFolder, placement, ancestorFormKey, path => SerializeAndWrite(_codec, bare, path, release));
        index.CreateWorkingTreeRecord(destinationPlugin, ancestorFormKey, ancestorRecordType, body);
        if (ownParent is { } parentSlot)
        {
            AppendChildToSlot(
                index, reads, destinationPlugin, parentSlot.ParentFormKey, parentSlot.ParentRecordType,
                parentSlot.SlotName, ancestorFormKey);
        }
        return Path.GetDirectoryName(recordDataPath)!;
    }

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

    // A destination loading before the origin would be an underride (#439's own operation), silently
    // beaten at runtime. A plugin the load order does not place passes.
    private RecordEditResult? RefuseIfUnderride(string formKey, PluginKey destinationPlugin)
    {
        var plugins = mirror.LoadOrder?.Plugins;
        if (plugins == null) return null;

        // A FormKey carries only a filename, so with two same-named copies (ADR-0036) the winning one
        // is the origin.
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

    // The one statement of which container types Copy as New Record supports (xEdit's DIAL/INFO/QUST
    // allowance).
    private static string? CopyAsNewContainerFamilyName(string recordType, GameRelease release)
    {
        var name = RecordTypeDispatch.For(release).ConcreteFor(recordType)?.Name;
        return name is "Quest" or "DialogTopic" or "DialogResponses" ? name : null;
    }

    // Verbatim source text, no deserialization; an untracked source falls back to the indexed body,
    // the only representation that exists for it.
    private string ReadCopySourceBody(PluginKey sourcePlugin, string formKey, RecordDocument document, GameRelease release)
    {
        if (TrackedCopySourcePath(sourcePlugin, formKey, document, release) is { } fullPath)
            return File.ReadAllText(fullPath);
        return document.Body!;
    }

    // Null when the indexed body is the right representation: an untracked source, an embedded record,
    // or a missing file. Full Resolve, since a container copy source has no flat path.
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

    // Duplicate needs an object to copy, unlike the override path.
    private IMajorRecord ReadCopySourceRecord(PluginKey sourcePlugin, string formKey, RecordDocument document, GameRelease release)
    {
        if (TrackedCopySourcePath(sourcePlugin, formKey, document, release) is { } fullPath)
            return _codec.DeserializeAsync(fullPath, release, document.RecordType).GetAwaiter().GetResult();

        return _codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body!), release, document.RecordType)
            .GetAwaiter().GetResult();
    }

    // The codec's own write-then-rename, needed here because Copy as Override writes text directly.
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

    /// <summary>A delete+create pair in source terms plus a reference cascade. Native records only; an
    /// untracked referencer refuses before any write. Computed whole, then written through a
    /// <see cref="SourceWriteTransaction"/> that restores every tree on failure (ADR-0045).</summary>
    public RecordEditResult RenumberRecord(PluginKey plugin, string formKey, string? requestedFormKey = null)
    {
        // unit is discarded: this is only the existence check, and the compute phases re-resolve
        // fresh. RecordType is kept for the header check, since a ModHeader cannot run through
        // ReadRecordFromSource.
        if (ResolveEditTarget(plugin, formKey, out var target) is { } blocked) return blocked;
        var (index, modFolder, release, document, _) = target;
        if (RefuseIfHeader(document.RecordType) is { } headerRefusal) return headerRefusal;

        // Canonicalised once: two ordinal comparisons below (the exclusion predicate and the
        // remap-completeness guard) run against canonical text, and a differently-cased spelling
        // would silently turn both into no-ops.
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

        // Deduplicated by source record: one typed remap moves every link in a record's graph. The
        // target itself is excluded even when self-referencing: ComputeTargetRewrite applies the same
        // mapping, and a second independent graph's write would discard the first.
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

        // Phase two: everything that can still fail is genuine I/O, recorded in one transaction
        // (ADR-0045).
        var transaction = new SourceWriteTransaction();
        try
        {
            foreach (var rewrite in rewrites) WriteComputedRewrite(index, transaction, rewrite, release);
            WriteTargetRewrite(index, transaction, plugin, modFolder, targetRewrite, formKey, targetFormKey, release);
        }
        catch (Exception ex)
        {
            // Unfiltered so an unexpected fault is rolled back and disclosed rather than falling
            // through to the endpoint's InvalidOperationException handler ("no usable load order").
            // Rethrown as IOException so it reaches the client as the same 500 every write fault does.
            throw new IOException(RollBackFailedRenumber(transaction, plugin, rewrites, formKey, targetFormKey, ex), ex);
        }
        finally
        {
            // On both outcomes: after a rollback the affected plugins have been re-derived and the
            // filter must not stay stale. Once rather than per write; SetFilter re-derives the full set.
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

    // The index is re-derived, not unwound (ADR-0045): it is a cache over the source trees. Paths are
    // named relative to the mod folder, the form the Source Control panel lists; absolute paths go to
    // the log only.
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
                // Already in the load order's LoadFailures (ADR-0026); named here too because "the
                // files went back but the index did not follow" is part of this message.
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

    // The cause is the only thing that says why, so it is relativized rather than dropped; the log
    // keeps the untouched original. Textual, since an exception message is prose.
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

    // Record is the file's top-level record: the referencer itself, or its owner when embedded.
    private sealed record ComputedRewrite(
        PluginKey Plugin,
        string ModFolder,
        string FilePath,
        IMajorRecord Record,
        IReadOnlyList<(string FormKey, string? Body)> IndexChanges);

    // Grouped by file before anything is read, so a container document holding several referencers
    // is remapped once; per-referencer graphs would discard each other's writes. The typed remap
    // moves links and only links; RefuseIfRemapIncomplete covers its one gap.
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
            if (RefuseIfRemapIncomplete(owner, ownerDoc.RecordType, oldFormKey, referencerPlugin, release) is { } incomplete)
                return incomplete;

            var changes = new List<(string FormKey, string? Body)> { (unit.OwnerFormKey, ownerBody) };
            foreach (var (embeddedFormKey, _, _) in group.Where(r => r.Unit.IsEmbedded))
            {
                // The child's row is re-derived from the remapped owner, the same two-row shape
                // EditField uses. A remap never moves a record's own FormKey, so the child is still
                // found under the same key.
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
                        child, childDoc?.RecordType ?? unit.OwnerRecordType, oldFormKey, referencerPlugin, release)
                    is { } childIncomplete) return childIncomplete;

                changes.Add((embeddedFormKey, SerializeToText(child, release)));
            }

            // Carried rather than recomputed at write time: the transaction names unrestored paths
            // relative to this folder.
            rewrites.Add(new ComputedRewrite(
                referencerPlugin, ModFolders.TrackedOf(mirror.LoadOrder, referencerPlugin)!,
                filePath, owner, changes));
        }

        return null;
    }

    private static Dictionary<FormKey, FormKey> RenumberMapping(string oldFormKey, string newFormKey) =>
        new() { [FormKey.Factory(oldFormKey)] = FormKey.Factory(newFormKey) };

    private string SerializeToText(IMajorRecordGetter record, GameRelease release) =>
        Encoding.UTF8.GetString(_codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult());

    // Mutagen's generated RemapLinks never descends into ScriptStructListProperty.Structs
    // (upstream-mutagen-issue.md); delete this guard when the upstream fix ships. Asked of
    // PluginIngest.CollectFormRefs, not the text: text cannot tell a link from an EditorID or string.
    private RecordEditResult? RefuseIfRemapIncomplete(
        IMajorRecordGetter record, string recordType, string oldFormKey, PluginKey plugin, GameRelease release)
    {
        var refs = new List<FormRef>();
        if (!schemaReflector.GetSchemas(release).TryGetValue(recordType, out var schema))
        {
            // A record from an indexed document always has a schema; refusing keeps the guard's
            // conservative direction: a guard that cannot run has cleared nothing.
            return RecordEditResult.Refused(
                RecordEditRefusal.ReferenceRemapIncomplete,
                $"'{recordType}' has no reflected schema, so the remap-completeness check for " +
                $"{record.FormKey} in {plugin.Name} could not run. Nothing was written.");
        }

        PluginIngest.CollectFormRefs(refs, record, recordType, schema);
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

    // The transaction holds the pre-image and wraps the write in InMintedDirectory like every other
    // source-tree write (#675).
    private void WriteComputedRewrite(
        IRecordIndex index, SourceWriteTransaction transaction, ComputedRewrite rewrite, GameRelease release)
    {
        transaction.Write(
            rewrite.ModFolder, rewrite.FilePath,
            () => _codec.SerializeAsync(rewrite.Record, rewrite.FilePath, release).GetAwaiter().GetResult());

        index.ApplyWorkingTreeChanges(rewrite.Plugin, rewrite.IndexChanges);
    }

    // Root is the record serialized at Unit.FullPath (the owner when embedded); ChildBody is the
    // embedded child's own body, null otherwise.
    private sealed record ComputedTarget(
        SourceUnit Unit, RecordDocument Document, IMajorRecord Root, string RootBody, string? ChildBody);

    // The referencer pass skips the target, so this is the only place a self-link is remapped.
    // Nothing here writes; both failure modes are typed refusals.
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
            // asked about; the self-link is remapped here and nowhere else.
            if (RefuseIfRemapIncomplete(owner, ownerDocument.RecordType, oldFormKey, plugin, release) is { } ownerIncomplete)
                return ownerIncomplete;
            if (RefuseIfRemapIncomplete(found.Child, document.RecordType, oldFormKey, plugin, release) is { } childIncomplete)
                return childIncomplete;

            ((IMajorRecordInternal)found.Child).FormKey = FormKey.Factory(newFormKey);

            target = new ComputedTarget(
                unit, document, owner, SerializeToText(owner, release), SerializeToText(found.Child, release));
            return null;
        }

        var record = ReadRecordFromSource(_codec, logger, unit.FullPath, document, release);
        ((IFormLinkContainer)record).RemapLinks(mapping);

        if (RefuseIfRemapIncomplete(record, document.RecordType, oldFormKey, plugin, release) is { } recordIncomplete)
            return recordIncomplete;

        ((IMajorRecordInternal)record).FormKey = FormKey.Factory(newFormKey);

        target = new ComputedTarget(unit, document, record, SerializeToText(record, release), ChildBody: null);
        return null;
    }

    private void WriteTargetRewrite(
        IRecordIndex index, SourceWriteTransaction transaction, PluginKey plugin, string modFolder,
        ComputedTarget target, string oldFormKey, string newFormKey, GameRelease release)
    {
        var (unit, document, root, rootBody, childBody) = target;
        if (unit.IsEmbedded)
        {
            // No file moves: an embedded record has no leaf name of its own. The owner is reserialized
            // and the child's row replaced, the same two-row shape EditField uses.
            transaction.Write(
                modFolder, unit.FullPath,
                () => _codec.SerializeAsync(root, unit.FullPath, release).GetAwaiter().GetResult());
            index.ApplyRenumber(plugin, new RenumberedRecord(
                oldFormKey, newFormKey, document.RecordType, childBody!,
                new EmbeddingOwner(unit.OwnerFormKey, rootBody)));
            return;
        }

        var record = root;

        var isDirectoryPerRecord = unit.IsDirectoryPerRecord;
        var oldLeafPath = isDirectoryPerRecord ? Path.GetDirectoryName(unit.FullPath)! : unit.FullPath;
        var parentDirectory = Path.GetDirectoryName(oldLeafPath)!;

        // Only the FormKey half of the leaf name changes. The parent's ordered list is keyed by
        // FormKey, so the entry is repointed in place rather than moved to the end; for
        // DialogTopic.Responses that is gameplay.
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
        // Nothing is normally minted here (the move or the resolved unit already put the directory in
        // place); the transaction's InMintedDirectory wrapper keeps that true rather than assumed (#675).
        transaction.Write(
            modFolder, writePath,
            () => _codec.SerializeAsync(record, writePath, release).GetAwaiter().GetResult());

        if (!isDirectoryPerRecord && File.Exists(unit.FullPath)) transaction.Delete(modFolder, unit.FullPath);

        // The carrier is a file this pass changed, so a failed renumber has to put it back too
        // (ADR-0045).
        if (SourceChildOrder.SlotHolding(parentDirectory, oldFormKey) is { } slot)
        {
            transaction.Write(
                modFolder, slot.Carrier,
                () => SourceChildOrder.Rename(slot.Carrier, slot.Key, oldFormKey, newFormKey));
        }

        // The whole index side in one call, and therefore one transaction (#677): a fault part-way
        // must not leave an index naming a FormKey no source file backs. Last act, to keep the
        // disk/index disagreement window smallest.
        index.ApplyRenumber(plugin, new RenumberedRecord(oldFormKey, newFormKey, document.RecordType, rootBody));
    }

    /// <summary>The same rule <see cref="IRecordIndex.CreateWorkingTreeRecord"/> enforces by throwing,
    /// checked first so a collision is a typed refusal.</summary>
    internal static bool IsFreeAtBothRefs(IRecordIndex index, PluginKey plugin, string formKey) =>
        index.At(RecordRef.Effective).GetDocument(formKey, plugin) == null
        && index.At(RecordRef.Head).GetDocument(formKey, plugin) == null;

    // Non-null is the refusal; targetFormKey is "" then, so call sites need no second null-check
    // after checking the return.
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
        // The ESL cap, not the FormKey space, is exhausted, and the light-ness is the removable header
        // flag: surfaced as a typed marker, the same way out compile offers.
        var eslContradiction = isLight
            && IsLightByRemovableFlag(index, plugin, mod)
            && NextFreeNativeFormId(index, plugin, mod, isLight: false) != null;
        return RecordEditResult.Refused(
            RecordEditRefusal.FormKeySpaceExhausted, FormKeySpaceExhaustedMessage(plugin, isLight, eslContradiction),
            eslContradiction);
    }

    // A .esl extension also reads as light but no header edit can un-flag it; working-tree-first so a
    // flag flipped this session answers immediately.
    private static bool IsLightByRemovableFlag(IRecordIndex index, PluginKey plugin, IModGetter? mod)
    {
        var headerFormKey = HeaderIndexer.FormKeyFor(ModKey.FromFileName(plugin.Name));
        if (index.At(RecordRef.Effective).GetDocument(headerFormKey, plugin)?.Body is { } body)
            return HeaderDocument.IsLight(Encoding.UTF8.GetBytes(body));
        return mod?.IsSmallMaster ?? false;
    }

    // The header document at Effective is the truth (ADR-0041), so a flag flipped this session caps
    // minting immediately; the loaded mod answers only when no document exists.
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

    // A foreign ModKey would land a record inside this plugin's tree while claiming another origin,
    // indistinguishable from a corrupt override; xEdit never offers one either. Range is checked
    // after ownership.
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

    // Falls back to the extension check when no mod object is loaded for the PluginKey.
    private static bool IsLightPlugin(IModGetter? mod, PluginKey plugin) =>
        mod != null
            ? PluginFlagPredicates.IsLight(mod, plugin.Name)
            : plugin.Name.EndsWith(".esl", StringComparison.OrdinalIgnoreCase);

    // Unions Effective (committed plus uncompiled creates) and Head (natives the working tree
    // deleted, whose IDs must not be reused before compile). Null means exhausted, a typed refusal
    // at both call sites.
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

    /// <summary>The same both-refs allocator create/renumber use, exposed so the Renumber input box can
    /// prefill a suggestion as xEdit does. Never a write and no tracked gate: pure arithmetic over
    /// indexed state.</summary>
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

    // Resolves against Effective: a record the working tree deleted still exists at Head. Not this
    // call's choice: form_lookup has no ref dimension; ApplyWorkingTreeChanges keeps it in step.
    // Scope is the reflected columns; VMAD/condition FormKeys are not checked.
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

        // The same builder the read model renders check errors from, so the two definitions of a
        // broken link cannot drift.
        return CheckErrorBuilder.Build(col.ToFieldMetadata(), value, reads.Resolve, release);
    }

    /// <summary>The palette title verbatim (package.json's "Track…" under category "Modbench"); a signpost
    /// naming a command the user cannot find is worse than none.</summary>
    internal const string TrackCommandTitle = "Modbench: Track\u2026";

    private readonly record struct EditTarget(
        IRecordIndex Index, string ModFolder, GameRelease Release, RecordDocument Document, SourceUnit Unit);

    // Reads the document at Effective because that is what the user is editing from: a second edit
    // must build on the first, not the committed baseline. The copy gestures gate on the destination
    // and read the source instead.
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

        // An embedded child (a placed ref, landscape, navmesh, top cell) resolves to its parent's file.
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

    private readonly record struct CopySource(IRecordIndex Index, string DestinationModFolder, GameRelease Release, RecordDocument Document);

    // Asymmetric by construction: the write-path gate checks the destination, the document lookup
    // reads the source. Never resolves a source unit; an untracked source falls back to the indexed
    // body.
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

    // INVARIANT: every write gesture calls this first (untracked, then the external-change deferral).
    // Reaching ApplyWorkingTreeChanges/CreateWorkingTreeRecord any other way bypasses the deferral
    // refusal entirely.
    private RecordEditResult? RefuseIfBlocked(PluginKey plugin, out string modFolder)
    {
        if (ModFolders.TrackedOf(mirror.LoadOrder, plugin) is not { } folder)
        {
            modFolder = "";
            return RefuseUntracked(plugin);
        }
        modFolder = folder;

        // Checked before anything else, so neither the source file nor the index call is ever reached.
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
                // The palette entry verbatim; naming a command that does not exist is its own dead end.
                $"Run \"{TrackCommandTitle}\" on it once to start editing.");

    // Refused before any write. Not folded into ResolveEditTarget because EditField reaches the
    // header deliberately. Without it, SourceUnit.IsDirectoryPerRecord (filename-only) answers true
    // for the header and DeleteRecord deletes the plugin's whole source root.
    private static RecordEditResult? RefuseIfHeader(string recordType) =>
        recordType == HeaderIndexer.RecordType
            ? RecordEditResult.Refused(
                RecordEditRefusal.HeaderDeleteOrRenumberNotSupported,
                "The plugin header cannot be deleted or renumbered — it is not an ordinary record.")
            : null;

    /// <summary>The synthetic header field the ESL flag is written through (<see cref="EditHeaderIsLight"/>).</summary>
    internal const string IsLightFieldPath = "is_light";

    // Transforms the header's current document (HeaderDocument.WithLightFlag), no in-memory mod
    // consulted, so a stale loaded-plugin object can never leak other header values into the write.
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

        // Warn, not info: flipping this flag shifts load-order behavior downstream, so the log keeps a
        // visible record.
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
        FieldApplyResult applied, string fieldPath, string recordType,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, JsonValueKind sentKind = default)
    {
        var outcome = applied.Outcome;
        // The key identifies the element, so the refusal names it — a caller told only that
        // something collided would have to diff the array itself to find out what.
        if (outcome == FieldApplyOutcome.DuplicateKeyInKeyedArray)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.DuplicateKeyInKeyedArray,
                $"'{fieldPath}' has two entries keyed '{applied.DuplicateKey}'. Entries there are " +
                "identified by that key rather than by position, so rename or remove one of the two.");
        }

        if (outcome == FieldApplyOutcome.ReadOnly)
            return RecordEditResult.Refused(RecordEditRefusal.FieldReadOnly, $"'{fieldPath}' is read-only.");

        // Answered directly from the applier: a well-typed element's declined sub-field reaches the
        // same "rejected, value is an array" shape, which a heuristic could not tell apart.
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
                RecordEditRefusal.FieldValueShapeMismatch, ComplexFieldShapeMessage(fieldPath, apiType, sentKind));
        }

        // The shape was fine; the named sub-field has no write door, so ValueShapeMismatch's message
        // would be false.
        if (outcome == FieldApplyOutcome.NestedFieldReadOnly)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.NestedFieldReadOnly,
                $"'{fieldPath}' contains a nested field that is not editable — that sub-field has " +
                "no write support; omit it from the payload to apply the rest.");
        }

        return RecordEditResult.Refused(RecordEditRefusal.FieldNotFound, $"'{recordType}' has no field '{fieldPath}'.");
    }

    // A complex field is written as one atomic value (CONTEXT.md): a bare element or member is told
    // to send the whole array or struct.
    private static string ComplexFieldShapeMessage(string fieldPath, string? apiType, JsonValueKind sentKind) =>
        (apiType, sentKind) switch
        {
            ("array", JsonValueKind.Array) => $"'{fieldPath}' has an element that was not accepted; " +
                                              "every element must be a value the array's element type takes.",
            ("array", _) => $"'{fieldPath}' is an array field: it takes the whole array as one value " +
                            "(a JSON array), not a single element.",
            ("struct", JsonValueKind.Object) => $"'{fieldPath}' has a member that was not accepted; " +
                                                "every member must be a value that member's type takes.",
            ("struct", _) => $"'{fieldPath}' is a struct field: it takes the whole struct as one value " +
                             "(a JSON object), not a single member.",
            _ => $"'{fieldPath}' did not accept a value of this JSON shape.",
        };

    // Create only: a brand-new record has no containment to resolve to, and choosing one is a UX
    // decision. FolderNameFor is also null for every record with no top-level group of its own,
    // which the message names.
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

    // xEdit refuses CELL/WRLD/LAND/NAVM/PGRD/ROAD/NAVI: a fresh FormKey leaves the copy with no group
    // to sit in. Only cell/wrld are named; the others have no schema table and already refuse as
    // RecordNotFound.
    private static RecordEditResult? RefuseIfDisallowedForCopyAsNewRecord(string recordType)
    {
        if (recordType is not ("cell" or "wrld")) return null;

        return RecordEditResult.Refused(
            RecordEditRefusal.CopyAsNewRecordDisallowedForType,
            $"'{recordType}' cannot be copied as a new record — xEdit itself refuses this for container " +
            "types (CELL, WRLD, LAND, NAVM, PGRD, ROAD, NAVI), since a fresh FormKey would leave the copy " +
            "with no group to belong to. Copy as Override, instead.");
    }

    // Narrower than RefuseIfContainerType: a container's own top-level record has a directory to
    // land in, so only a record with no container of its own anywhere in the tree refuses.
    private static RecordEditResult? RefuseIfCopySourceHasNoContainerOfItsOwn(string recordType, GameRelease release)
    {
        if (RecordTypeDispatch.For(release).GroupFolderNameFor(recordType) is not null) return null;

        return RecordEditResult.Refused(
            RecordEditRefusal.ContainerRecordNotYetSupported,
            $"'{recordType}' has no container of its own anywhere in the tree — it is a record embedded " +
            "in a container (a placed reference, a landscape, a navmesh) or a folder-split child with no " +
            "independent top-level existence (a dialog topic, a scene, a response).");
    }

    /// <summary>Interior placement carries no gameplay meaning (PlacementWalker records null block/sub
    /// for every interior cell), so this reuses whichever block/sub-block directory the destination
    /// already has, minting <c>0/0</c> only the first time.</summary>
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
            blockDirectory, "InteriorCellSubBlock", RecordTypeDispatch.BlockChildMember);

        return [Path.GetFileName(blockDirectory), Path.GetFileName(subBlockDirectory)];
    }

    // A freshly minted block has to join the parent's ordered child list under orderKey, or the next
    // read refuses the tree as drift.
    private static string FindOrMintGroupDirectory(string parentDirectory, string groupType, string orderKey)
    {
        var existing = Directory.EnumerateDirectories(parentDirectory).FirstOrDefault();
        if (existing != null) return existing;

        const string blockNumber = "0";
        var directory = Path.Combine(parentDirectory, blockNumber);
        WritePlaced(
            SourceChildOrder.CarrierFor(directory, parentIsRecord: false),
            SourceChildOrder.CarrierFor(parentDirectory, parentIsRecord: false),
            orderKey, blockNumber,
            _ =>
            {
                WriteMinimalGroupRecordDataIfMissing(directory, groupType);
                return "";
            });
        return directory;
    }

    // Matches Track's own WriteIndented output; WriteMinimalGroupRecordDataIfMissing's byte-exact
    // contract depends on it.
    private static readonly JsonSerializerOptions GroupRecordDataOptions = new() { WriteIndented = true };

    // Not a record the codec has a schema for, so written directly. BlockNumber is omitted because
    // Track omits a BlockNumber of 0; the bytes are verified identical to Track's for both shapes,
    // which byte-compare tooling depends on.
    private static void WriteMinimalGroupRecordDataIfMissing(string directory, string? groupType)
    {
        var path = Path.Combine(directory, "GroupRecordData.json");
        if (File.Exists(path)) return;
        var bytes = groupType == null
            ? JsonSerializer.SerializeToUtf8Bytes(new { }, GroupRecordDataOptions)
            : JsonSerializer.SerializeToUtf8Bytes(new { GroupType = groupType }, GroupRecordDataOptions);
        File.WriteAllBytes(path, bytes);
    }

    // The one place a plain Copy as Override deserializes at all; every other type's own-fields copy
    // is the verbatim bytes.
    private string StripEmbeddedChildrenForShallowCopy(string body, string recordType, GameRelease release)
    {
        var record = _codec.DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(body), release, recordType).GetAwaiter().GetResult();
        ContainerChildFields.ClearAllChildSlots(record);
        var stripped = _codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(stripped);
    }

    /// <summary>Falls back to the indexed body only when the file is missing (never-assume-exclusive-
    /// ownership): refusing would strand the user with no way to put the record back.</summary>
    internal static IMajorRecord ReadRecordFromSource(
        RecordTextCodec codec, ILogger logger, string sourcePath, RecordDocument document, GameRelease release)
    {
        if (File.Exists(sourcePath))
            return codec.DeserializeAsync(sourcePath, release, document.RecordType).GetAwaiter().GetResult();

        logger.LogWarning(
            "Source file {SourcePath} is missing; editing from the indexed document and rewriting it", sourcePath);
        return codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body!), release, document.RecordType)
            .GetAwaiter().GetResult();
    }

    /// <summary>Writes the file, then names it in the ordered child list (ADR-0042 decision 4), deleting
    /// the file if that fails: an unnamed file refuses the plugin at the next read. A minted
    /// directory is removed too.</summary>
    internal static string WritePlaced(string modFolder, SourcePlacement placement, string identity, Func<string, string> write) =>
        WritePlaced(
            Path.Combine(modFolder, placement.RelativePath),
            Path.Combine(modFolder, placement.CarrierRelativePath),
            placement.Key, identity, write);

    private static string WritePlaced(string path, string carrier, string key, string identity, Func<string, string> write) =>
        SourceUnitResolver.InMintedDirectory(Path.GetDirectoryName(path)!, () =>
        {
            var body = write(path);
            try
            {
                SourceChildOrder.Add(carrier, key, identity);
            }
            catch
            {
                File.Delete(path);
                throw;
            }
            return body;
        });

    /// <summary>Two serializations, one for the index and one for disk; <see cref="RecordTextCodec"/>
    /// producing identical bytes for both is what makes what the index is told and what lands the same text.</summary>
    internal static string SerializeAndWrite(RecordTextCodec codec, IMajorRecord record, string path, GameRelease release)
    {
        var bytes = codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();
        codec.SerializeAsync(record, path, release).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(bytes);
    }
}
