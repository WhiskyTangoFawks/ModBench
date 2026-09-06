using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
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

    /// <summary>The single write path (ADR-0041): one envelope, patched onto the record's document
    /// by <see cref="DocumentEdit"/>, landed here as a working-tree change. This method owns only
    /// the IO around that.</summary>
    public RecordEditResult Edit(PluginKey plugin, string formKey, RecordEditEnvelope envelope)
    {
        if (ResolveEditTarget(plugin, formKey, out var editTarget) is { } blocked) return blocked;
        var (index, _, release, document, unit) = editTarget;
        var spelled = RecordEditEnvelope.Spell(envelope.Path);

        if (document.ParseDiagnosis is { } diagnosis)
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.RecordParseFailed, spelled,
                $"{formKey} could not be read when it was indexed, so its document is a stub and nothing can be " +
                $"written to it: {diagnosis}");
        }

        var schemas = schemaReflector.GetSchemas(release);
        if (!schemas.TryGetValue(document.RecordType, out var schema))
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.FieldNotFound, spelled, $"'{document.RecordType}' is not an editable record type.");
        }
        if (RefuseIfContainmentField(document.RecordType, envelope.Path, schemas, release) is { } containmentRefusal)
            return containmentRefusal;

        var reads = index.At(RecordRef.Effective);
        var owner = reads.GetDocument(unit.OwnerFormKey, plugin)!;
        var text = ReadSourceText(unit.FullPath, owner);

        // An embedded child is patched inside its parent's document: the parent is what the file
        // holds and what the codec reads, so every untouched byte of it comes back intact.
        IReadOnlyList<PathHop> prefix = [];
        if (unit.IsEmbedded)
        {
            var parentType = RecordTypeDispatch.For(release).ConcreteFor(unit.OwnerRecordType);
            var found = parentType == null
                ? null
                : EmbeddedChildPath.Find((JsonObject)JsonNode.Parse(text)!, ContainerChildFields.NormalizedTypeName(parentType), formKey);
            if (found == null)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    // Deliberately does not blame an external change: a defect reads identically, and a
                    // wrong explanation sends the user hunting a problem that is not there.
                    $"{unit.RelativePath} is indexed as holding {formKey}, but its own text does not " +
                    "carry it. If nothing outside Modbench changed that file, this is a defect — please " +
                    "report it; otherwise relaunch mEdit so the index re-reads the tree.");
            }
            prefix = found;
        }

        Func<string, string> roundTrip = schema.IsHeader
            ? patched => Encoding.UTF8.GetString(HeaderDocument.Write(HeaderDocument.Read(Encoding.UTF8.GetBytes(patched))))
            : patched => _codec.RoundTrip(patched, release, unit.OwnerRecordType);
        var request = new DocumentEditRequest(text, prefix, schema, envelope, release, reads.Resolve, roundTrip);
        if (DocumentEdit.Apply(request, out var newText) is { } refused) return refused;

        // The document already said this (a value set to itself): nothing to commit, so no dirty file
        // or history entry.
        if (string.Equals(newText, text, StringComparison.Ordinal)) return RecordEditResult.Success();

        // The file name carries the EditorID, so an EditorID edit is a rename too. Done before the write.
        var newEditorId = unit.IsEmbedded ? document.EditorId : EditorIdOf(newText);
        var sourcePath = RenameSourceUnit(unit, FormKey.Factory(unit.OwnerFormKey), newEditorId, document);

        // The atomic write matters here: the file is inside a live git working tree the SCM panel may
        // read at any moment.
        WriteBodyAtomic(sourcePath, newText);

        // The unit's document is what changed; an embedded child's own row is the index's derivation
        // from it.
        index.ApplyWorkingTreeChanges(plugin, [(unit.OwnerFormKey, newText)]);

        // The new value can flip filter membership either way.
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Edited {Op} {Path} on {FormKey} in {Plugin} ({Origin}) — working-tree change written to {SourcePath}",
                envelope.Op, spelled, formKey, plugin.Name, plugin.Origin, unit.RelativePath);
        }
        return RecordEditResult.Success();
    }

    private static string? EditorIdOf(string text)
    {
        using var document = JsonDocument.Parse(text);
        return document.RootElement.TryGetProperty(nameof(IMajorRecordGetter.EditorID), out var editorId)
            && editorId.ValueKind == JsonValueKind.String
            ? editorId.GetString()
            : null;
    }

    // Falls back to the indexed body only when the file is missing (never assume exclusive
    // ownership): refusing would strand the user with no way to put the record back.
    private string ReadSourceText(string sourcePath, RecordDocument document)
    {
        if (File.Exists(sourcePath)) return File.ReadAllText(sourcePath);
        logger.LogWarning(
            "Source file {SourcePath} is missing; editing from the indexed document and rewriting it", sourcePath);
        return document.Body!;
    }

    /// <summary>The codec is the one constructor: a record begins as the document naming its identity,
    /// read back through the door every edit goes through. <paramref name="partialForm"/> sets the
    /// header bit a bare container ancestor carries.</summary>
    internal static IMajorRecord BareRecord(
        RecordTextCodec codec, RecordTableSchema schema, GameRelease release, string formKey, string? editorId, bool partialForm)
    {
        var members = new JsonObject();
        // ADR-0041's discriminator policy: a path-ambiguous document leads with its concrete type.
        if (RecordTypeDispatch.For(release).IsPathAmbiguous(schema.TableName)
            && ReflectedTypes.GetSetterType(schema.RecordType) is { } concrete)
        {
            members[LoquiUnions.UnionTypeDiscriminator] = ReflectedTypes.DocumentTypeName(concrete);
        }
        members[nameof(IMajorRecordGetter.FormKey)] = formKey;
        if (editorId != null) members[nameof(IMajorRecordGetter.EditorID)] = editorId;
        if (partialForm) members[nameof(IMajorRecordGetter.MajorRecordFlagsRaw)] = PartialFormFlag.Bit;
        return codec.DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(members.ToJsonString()), release, schema.TableName)
            .GetAwaiter().GetResult();
    }

    // Reflection makes child slots, Cell.Grid and placed Position ordinary writable columns; writing
    // one would desynchronize the side tables, which nothing here re-derives. Refusing is why no
    // SetPlacement-style write-back exists; containment is the path (ADR-0041).
    private static RecordEditResult? RefuseIfContainmentField(
        string recordType, IReadOnlyList<PathHop> path, IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release)
    {
        var fieldPath = path.Count > 0 ? path[0].Name : null;
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
    private string RenameSourceUnit(SourceUnit unit, FormKey formKey, string? editorId, RecordDocument document)
    {
        // An embedded child's EditorID appears in no path: the file belongs to its parent, whose own
        // EditorID this edit did not touch. Nothing to move.
        if (unit.IsEmbedded) return unit.FullPath;
        if (string.Equals(editorId, document.EditorId, StringComparison.Ordinal)) return unit.FullPath;

        var isDirectoryPerRecord = unit.IsDirectoryPerRecord;
        var oldLeafPath = isDirectoryPerRecord ? Path.GetDirectoryName(unit.FullPath)! : unit.FullPath;

        // A leaf is named by identity alone (ADR-0042 decision 4), so a rename touches no sibling or
        // parent document.
        var newLeafName = SourceUnitResolver.LeafNameFor(formKey, editorId, isDirectoryPerRecord);
        var newLeafPath = Path.Combine(Path.GetDirectoryName(oldLeafPath)!, newLeafName);

        if (string.Equals(oldLeafPath, newLeafPath, StringComparison.Ordinal)) return unit.FullPath;

        if (isDirectoryPerRecord)
        {
            Directory.Move(oldLeafPath, newLeafPath);
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation(
                    "EditorID changed on {FormKey}; moved its source directory {Old} to {New}",
                    formKey, Path.GetFileName(oldLeafPath), Path.GetFileName(newLeafPath));
            }
            return Path.Combine(newLeafPath, SourceUnitResolver.RecordDataFileName);
        }

        File.Move(oldLeafPath, newLeafPath, overwrite: true);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "EditorID changed on {FormKey}; moved its source file {Old} to {New}",
                formKey, Path.GetFileName(oldLeafPath), Path.GetFileName(newLeafPath));
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

        // One changed document either way: the owner without the child, or the record's own gone.
        // Every descendant's row follows from that in the index.
        (string FormKey, string? Body) delta;

        if (unit.IsEmbedded)
        {
            var owner = reads.GetDocument(unit.OwnerFormKey, plugin)!;
            var record = ReadRecordFromSource(_codec, logger, unit.FullPath, owner, release);

            if (!ContainerChildFields.RemoveEmbeddedChild(record, formKey))
            {
                // Same diagnosis as Edit's embedded lookup: states only what is observed.
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    $"{unit.RelativePath} is indexed as holding {formKey}, but its own text does not " +
                    "carry it. If nothing outside Modbench changed that file, this is a defect — please " +
                    "report it; otherwise relaunch mEdit so the index re-reads the tree.");
            }

            delta = (unit.OwnerFormKey, SerializeAndWrite(_codec, record, unit.FullPath, release));
        }
        else
        {
            // The unit may already be gone (another tool, a hand delete): that is the state this call
            // is trying to reach, not a failure.
            if (unit.IsDirectoryPerRecord)
            {
                var directory = Path.GetDirectoryName(unit.FullPath)!;
                if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
            }
            else if (File.Exists(unit.FullPath))
            {
                File.Delete(unit.FullPath);
            }

            delta = (formKey, null);
        }

        index.ApplyWorkingTreeChanges(plugin, [delta]);
        // A deleted row cannot match an active filter.
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Deleted {FormKey} from {Plugin} ({Origin}) — working-tree deletion of {SourcePath}",
                formKey, plugin.Name, plugin.Origin, unit.RelativePath);
        }
        return RecordEditResult.Success();
    }

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

        var record = BareRecord(
            _codec, schema, release, targetFormKey, string.IsNullOrWhiteSpace(editorId) ? null : editorId, partialForm: false);

        // RefuseIfContainerType guarantees a flat record, so no block path. The group folder is minted
        // by the write itself when the plugin has never held this type.
        var placement = SourcePlacement.For(plugin.Name, recordType, targetFormKey, record.EditorID, release);
        var relativePath = placement.RelativePath;
        var newBody = WriteAt(modFolder, placement, path => SerializeAndWrite(_codec, record, path, release));

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

        // A record a container's document carries lands inside the destination's copy of that
        // document (the container rule); the refusal below is for a record with no group of its own
        // that no readable container document carries.
        if (RecordTypeDispatch.For(release).GroupFolderNameFor(document.RecordType) is null
            && _recordCopy.EmbeddedContainerOf(reads, sourcePlugin, formKey, release) is { } embedding)
        {
            return _recordCopy.CopyEmbeddedChildAsOverride(
                sourcePlugin, formKey, document, embedding, destinationPlugin, destinationModFolder, index, release);
        }

        if (RefuseIfCopySourceHasNoContainerOfItsOwn(document.RecordType, release) is { } containerRefusal) return containerRefusal;

        var isContainer = IsContainerType(document.RecordType, release);
        if (!IsFreeAtBothRefs(index, destinationPlugin, formKey))
        {
            // A destination already overriding the explicitly-selected container record gets it
            // replaced, own-fields-only (xEdit's copy-into behavior). Every other record still
            // refuses, as does a record held only at Head.
            if (isContainer && reads.GetDocument(formKey, destinationPlugin) is { } existingTarget)
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
                $"{formKey} is an exterior cell with no worldspace grid position of its own — a worldspace's " +
                $"persistent cell, not one of its numbered blocks — so Copy as Override cannot create it in " +
                $"{destinationPlugin.Name}.");
        }

        var body = ReadCopySourceBody(sourcePlugin, formKey, document, release);

        // A plain Copy as Override is own-fields-only, so a container's inline children are stripped.
        if (isContainer) body = StripEmbeddedChildrenForShallowCopy(body, document.RecordType, release);

        // A Cell's block bucket is the one thing resolved first, because it is chosen (or minted)
        // rather than derived.
        var destination = SourcePlacement.For(
            destinationPlugin.Name, document.RecordType, formKey, document.EditorId, release,
            isCell ? EnsureInteriorCellBlockPath(destinationModFolder, destinationPlugin.Name, release) : null);
        var relativePath = destination.RelativePath;
        WriteAt(destinationModFolder, destination, path =>
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

        // A record with no group of its own copies into its container's document (a topic into its
        // quest, a response into its topic); a placed reference has no such container and refuses.
        if (RecordTypeDispatch.For(release).FolderNameFor(document.RecordType) is null)
        {
            if (index.At(RecordRef.Effective).GetContainerParent(sourcePlugin, formKey) is { } parent)
            {
                return CopyEmbeddedChildAsNewRecord(
                    index, sourcePlugin, formKey, document, parent, destinationPlugin, destinationModFolder, release, requestedFormKey);
            }
            if (RefuseIfContainerType(document.RecordType, release) is { } containerRefusal) return containerRefusal;
        }

        if (ResolveTargetFormKey(index, destinationPlugin, requestedFormKey, out var targetFormKey) is { } refusedTarget)
            return refusedTarget;

        var sourceRecord = ReadCopySourceRecord(sourcePlugin, formKey, document, release);
        var newRecord = sourceRecord.Duplicate(FormKey.Factory(targetFormKey));
        RemapSelfLink(newRecord, formKey, targetFormKey);

        // Own-record-only, like Copy as Override: a container's children never ride along (deep copy
        // is a separate operation).
        ContainerChildFields.ClearAllChildSlots(newRecord);
        var placement = SourcePlacement.For(
            destinationPlugin.Name, document.RecordType, targetFormKey, newRecord.EditorID, release);
        var relativePath = placement.RelativePath;
        var newBody = WriteAt(destinationModFolder, placement, path => SerializeAndWrite(_codec, newRecord, path, release));

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
    // cannot delete them. An EditorID difference renames the unit, since the round-trip gate
    // regenerates canonical names.
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

        var writePath = RenameSourceUnit(unit, replacement.FormKey, replacement.EditorID, existingTarget);
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

    // The embedded subtree rides along, each record under a fresh key drawn before anything is written.
    // Links between copied siblings are not remapped, xEdit's own behavior. A missing container chain
    // auto-creates bare and Partial Form.
    private RecordEditResult CopyEmbeddedChildAsNewRecord(
        IRecordIndex index, PluginKey sourcePlugin, string formKey, RecordDocument document, ContainerChildRow parent,
        PluginKey destinationPlugin, string destinationModFolder, GameRelease release, string? requestedFormKey)
    {
        var reads = index.At(RecordRef.Effective);
        if (RefuseIfAnyDescendantParseFailed(reads, sourcePlugin, formKey) is { } descendantRefusal) return descendantRefusal;

        if (ResolveTargetFormKey(index, destinationPlugin, requestedFormKey, out var targetFormKey) is { } refusedTarget)
            return refusedTarget;

        var newRecord = ReadCopySourceRecord(sourcePlugin, formKey, document, release).Duplicate(FormKey.Factory(targetFormKey));
        RemapSelfLink(newRecord, formKey, targetFormKey);

        var taken = new HashSet<string>(StringComparer.Ordinal) { targetFormKey };
        if (RekeyEmbeddedDescendants(index, destinationPlugin, newRecord, taken) is { } childRefused) return childRefused;

        var appended = _recordCopy.AppendEmbeddedChild(
            sourcePlugin, parent.ParentFormKey, parent.ParentRecordType, parent.SlotName, newRecord,
            destinationPlugin, destinationModFolder, index, release);
        if (!appended.Applied) return appended;

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as new record {NewFormKey} into " +
                "{DestinationPlugin} ({DestinationOrigin}) — inside {ContainerFormKey}'s {SlotName} slot, " +
                "with {DescendantCount} embedded descendant(s) each under a fresh FormKey",
                formKey, sourcePlugin.Name, sourcePlugin.Origin, targetFormKey, destinationPlugin.Name,
                destinationPlugin.Origin, parent.ParentFormKey, parent.SlotName, taken.Count - 1);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    // Every embedded descendant is copied too, so an unreadable one is refused before anything is
    // written. A stub is all a parse-failed record has.
    private static RecordEditResult? RefuseIfAnyDescendantParseFailed(IRecordReads reads, PluginKey plugin, string containerFormKey)
    {
        foreach (var childFormKey in reads.GetContainerChildren(plugin, containerFormKey).Select(c => c.ChildFormKey))
        {
            if (reads.GetDocument(childFormKey, plugin) is { } childDocument
                && RefuseIfParseFailed(childFormKey, childDocument) is { } childRefusal)
            {
                return childRefusal;
            }
            if (RefuseIfAnyDescendantParseFailed(reads, plugin, childFormKey) is { } deeper) return deeper;
        }
        return null;
    }

    // In place, on the duplicate's own graph: the list order is untouched, and a child's own
    // embedded children are re-keyed the same way one level down.
    private RecordEditResult? RekeyEmbeddedDescendants(
        IRecordIndex index, PluginKey destinationPlugin, IMajorRecordGetter container, HashSet<string> taken)
    {
        var containerType = ContainerChildFields.NormalizedTypeName(container.GetType());
        foreach (var (slotName, _, child) in ContainerChildFields.EnumerateChildren(container).ToList())
        {
            if (!ContainerChildFields.EmbeddedSlots.Contains((containerType, slotName))) continue;
            if (ResolveTargetFormKey(index, destinationPlugin, requestedFormKey: null, out var childFormKey, taken) is { } refused)
                return refused;
            taken.Add(childFormKey);

            var oldFormKey = child.FormKey.ToString();
            ((IMajorRecordInternal)child).FormKey = FormKey.Factory(childFormKey);
            RemapSelfLink(child, oldFormKey, childFormKey);
            if (RekeyEmbeddedDescendants(index, destinationPlugin, child, taken) is { } deeper) return deeper;
        }
        return null;
    }

    // A self-link is remapped onto the new FormKey, as xEdit does.
    private static void RemapSelfLink(IMajorRecordGetter record, string oldFormKey, string newFormKey)
    {
        if (record is IFormLinkContainer links)
            links.RemapLinks(new Dictionary<FormKey, FormKey> { [FormKey.Factory(oldFormKey)] = FormKey.Factory(newFormKey) });
    }

    // A destination loading before the origin would be an underride, silently
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

    // A record with child slots: the copy gestures land it own-fields-only, and replace an existing
    // override in place rather than refusing.
    private static bool IsContainerType(string recordType, GameRelease release) =>
        RecordTypeDispatch.For(release).ConcreteFor(recordType) is { } concrete
        && ContainerChildFields.EnumerateChildFieldsFor(concrete) != null;

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
                // Already in the load order's Failures (ADR-0026); named here too because "the
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
                    $"{referencerPlugin.Name} does not hold {referencerFormKey}, which the index lists " +
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
                    $"{referencerPlugin.Name} does not hold {unit.OwnerFormKey}, the record {unit.RelativePath} " +
                    $"carries. Nothing was written — reindex {referencerPlugin.Name} and try again.");
            }

            var owner = ReadRecordFromSource(_codec, logger, filePath, ownerDoc, release);
            ((IFormLinkContainer)owner).RemapLinks(mapping);
            var ownerBody = SerializeToText(owner, release);
            if (RefuseIfRemapIncomplete(owner, ownerDoc.RecordType, oldFormKey, referencerPlugin, release) is { } incomplete)
                return incomplete;

            foreach (var (embeddedFormKey, _, _) in group.Where(r => r.Unit.IsEmbedded))
            {
                // A remap never moves a record's own FormKey, so the child is still found under the
                // same key; its row is the index's derivation from the remapped owner.
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
            }

            // Carried rather than recomputed at write time: the transaction names unrestored paths
            // relative to this folder.
            rewrites.Add(new ComputedRewrite(
                referencerPlugin, ModFolders.TrackedOf(mirror.LoadOrder, referencerPlugin)!,
                filePath, owner, [(unit.OwnerFormKey, ownerBody)]));
        }

        return null;
    }

    private static Dictionary<FormKey, FormKey> RenumberMapping(string oldFormKey, string newFormKey) =>
        new() { [FormKey.Factory(oldFormKey)] = FormKey.Factory(newFormKey) };

    private string SerializeToText(IMajorRecordGetter record, GameRelease release) =>
        Encoding.UTF8.GetString(_codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult());

    // A link the typed remap left behind is refused wherever it sits; a KnownDefects row is what
    // names the member Mutagen is known to skip. Asked of PluginIngest.CollectFormRefs: text cannot
    // tell a link from an EditorID or string.
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

        using (var document = JsonDocument.Parse(SerializeToText(record, release)))
            PluginIngest.CollectFormRefs(refs, record.FormKey.ToString(), record.EditorID, document.RootElement, recordType, schema);
        if (refs.FirstOrDefault(r => r.TargetFormKey == oldFormKey) is { TargetFormKey: not null } stale)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.ReferenceRemapIncomplete,
                $"{record.FormKey} in {plugin.Name} still links {oldFormKey} at {stale.FieldPath} after the " +
                $"typed link remap, so renumbering would leave that reference dangling. {WhyRemapIsIncomplete(stale, release)} " +
                "Nothing was written.");
        }

        return null;
    }

    // A reference path is member names separated by dots, with an element index in brackets.
    private static readonly char[] PathHopSeparators = ['.', '['];

    // The row whose member the surviving link sits under, where one names it: the path is the
    // document's own member names, so a row's member name is a hop of it.
    private string WhyRemapIsIncomplete(FormRef stale, GameRelease release) =>
        schemaReflector.DefectsWith(release, KnownDefectEffect.RenumberRemapIncomplete)
            .FirstOrDefault(d => stale.FieldPath.Split(PathHopSeparators).Contains(d.MemberName, StringComparer.Ordinal))
            is { } defect
                ? $"{defect.TypeName}.{defect.MemberName}: {defect.Reason}."
                : "No known-defect row names a member Mutagen's generated remap skips, so the cause is unknown.";

    // The transaction holds the pre-image and wraps the write in InMintedDirectory like every other
    // source-tree write.
    private void WriteComputedRewrite(
        IRecordIndex index, SourceWriteTransaction transaction, ComputedRewrite rewrite, GameRelease release)
    {
        transaction.Write(
            rewrite.ModFolder, rewrite.FilePath,
            () => _codec.SerializeAsync(rewrite.Record, rewrite.FilePath, release).GetAwaiter().GetResult());

        index.ApplyWorkingTreeChanges(rewrite.Plugin, rewrite.IndexChanges);
    }

    // Root is the record serialized at Unit.FullPath: the owner when embedded.
    private sealed record ComputedTarget(SourceUnit Unit, RecordDocument Document, IMajorRecord Root, string RootBody);

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
                $"{plugin.Name} does not hold {oldFormKey}. Nothing was written — reindex {plugin.Name} and try again.");
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
                    $"{plugin.Name} does not hold {unit.OwnerFormKey}, the record {unit.RelativePath} carries " +
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
            // asked about.
            if (RefuseIfRemapIncomplete(owner, ownerDocument.RecordType, oldFormKey, plugin, release) is { } ownerIncomplete)
                return ownerIncomplete;
            if (RefuseIfRemapIncomplete(found.Child, document.RecordType, oldFormKey, plugin, release) is { } childIncomplete)
                return childIncomplete;

            ((IMajorRecordInternal)found.Child).FormKey = FormKey.Factory(newFormKey);

            target = new ComputedTarget(unit, document, owner, SerializeToText(owner, release));
            return null;
        }

        var record = ReadRecordFromSource(_codec, logger, unit.FullPath, document, release);
        ((IFormLinkContainer)record).RemapLinks(mapping);

        if (RefuseIfRemapIncomplete(record, document.RecordType, oldFormKey, plugin, release) is { } recordIncomplete)
            return recordIncomplete;

        ((IMajorRecordInternal)record).FormKey = FormKey.Factory(newFormKey);

        target = new ComputedTarget(unit, document, record, SerializeToText(record, release));
        return null;
    }

    private void WriteTargetRewrite(
        IRecordIndex index, SourceWriteTransaction transaction, PluginKey plugin, string modFolder,
        ComputedTarget target, string oldFormKey, string newFormKey, GameRelease release)
    {
        var (unit, document, root, rootBody) = target;
        if (unit.IsEmbedded)
        {
            // No file moves: an embedded record has no leaf name of its own. The owner is reserialized
            // around the child's new FormKey, and the index derives the new identity and the old one's
            // absence from that one document.
            transaction.Write(
                modFolder, unit.FullPath,
                () => _codec.SerializeAsync(root, unit.FullPath, release).GetAwaiter().GetResult());
            index.ApplyWorkingTreeChanges(plugin, [(unit.OwnerFormKey, rootBody)]);
            return;
        }

        var record = root;

        var isDirectoryPerRecord = unit.IsDirectoryPerRecord;
        var oldLeafPath = isDirectoryPerRecord ? Path.GetDirectoryName(unit.FullPath)! : unit.FullPath;
        var parentDirectory = Path.GetDirectoryName(oldLeafPath)!;

        // Only the FormKey half of the leaf name changes.
        var newLeafName =
            SourceUnitResolver.LeafNameFor(FormKey.Factory(newFormKey), document.EditorId, isDirectoryPerRecord);
        var newLeafPath = Path.Combine(parentDirectory, newLeafName);

        string writePath;
        if (isDirectoryPerRecord)
        {
            // Moved whole, not recreated from scratch: a worldspace's block subtree travels with it
            // rather than being orphaned.
            transaction.Move(modFolder, oldLeafPath, newLeafPath);
            writePath = Path.Combine(newLeafPath, SourceUnitResolver.RecordDataFileName);
        }
        else
        {
            writePath = newLeafPath;
        }
        // Nothing is normally minted here (the move or the resolved unit already put the directory in
        // place); the transaction's InMintedDirectory wrapper keeps that true rather than assumed.
        transaction.Write(
            modFolder, writePath,
            () => _codec.SerializeAsync(record, writePath, release).GetAwaiter().GetResult());

        if (!isDirectoryPerRecord && File.Exists(unit.FullPath)) transaction.Delete(modFolder, unit.FullPath);

        // The whole index side in one call, and therefore one transaction: a fault part-way
        // must not leave an index naming a FormKey no source file backs. Last act, to keep the
        // disk/index disagreement window smallest.
        index.ApplyRenumber(plugin, new RenumberedRecord(oldFormKey, newFormKey, document.RecordType, rootBody));
    }

    /// <summary>The same rule <see cref="IRecordIndex.CreateWorkingTreeRecord"/> enforces by throwing,
    /// checked first so a collision is a typed refusal.</summary>
    internal static bool IsFreeAtBothRefs(IRecordIndex index, PluginKey plugin, string formKey) =>
        index.At(RecordRef.Effective).GetDocument(formKey, plugin) == null
        && index.At(RecordRef.Head).GetDocument(formKey, plugin) == null;

    // Non-null is the refusal; targetFormKey is "" then, so call sites need no second null-check.
    // taken: keys this gesture drew but has not written, so one document's records get distinct keys.
    private RecordEditResult? ResolveTargetFormKey(
        IRecordIndex index, PluginKey plugin, string? requestedFormKey, out string targetFormKey,
        IReadOnlySet<string>? taken = null)
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

        var allocated = NextFreeNativeFormId(index, plugin, mod, isLight, taken);
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
            && NextFreeNativeFormId(index, plugin, mod, isLight: false, taken) != null;
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
    // deleted, whose IDs must not be reused before compile). Null means exhausted.
    private static string? NextFreeNativeFormId(
        IRecordIndex index, PluginKey plugin, IModGetter? mod, bool isLight, IReadOnlySet<string>? taken = null)
    {
        var floor = mod?.GetDefaultInitialNextFormID() ?? 0x800u;
        var highest = index.At(RecordRef.Effective).GetNativeFormKeys(plugin)
            .Concat(index.At(RecordRef.Head).GetNativeFormKeys(plugin))
            .Concat(taken ?? Enumerable.Empty<string>())
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

        if (RefuseIfParseFailed(formKey, document) is { } parseRefusal) return parseRefusal;

        var release = mirror.LoadOrder!.GameRelease;
        source = new CopySource(index, destinationModFolder, release, document);
        return null;
    }

    // A stub is all a parse-failed record has, so copying it would land its FormKey and EditorID as
    // a real record and silently drop everything else.
    private static RecordEditResult? RefuseIfParseFailed(string formKey, RecordDocument document) =>
        document.ParseDiagnosis is { } diagnosis
            ? RecordEditResult.Refused(
                RecordEditRefusal.RecordParseFailed,
                $"{formKey} could not be read when it was indexed, so its document is a stub holding only its " +
                $"FormKey and EditorID; copying it would land that stub rather than the record: {diagnosis}")
            : null;

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

    // Refused before any write. Not folded into ResolveEditTarget because Edit reaches the
    // header deliberately. Without it, SourceUnit.IsDirectoryPerRecord (filename-only) answers true
    // for the header and DeleteRecord deletes the plugin's whole source root.
    private static RecordEditResult? RefuseIfHeader(string recordType) =>
        recordType == HeaderIndexer.RecordType
            ? RecordEditResult.Refused(
                RecordEditRefusal.HeaderDeleteOrRenumberNotSupported,
                "The plugin header cannot be deleted or renumbered — it is not an ordinary record.")
            : null;

    // Create only: a brand-new record has no containment to resolve to, and choosing one is a UX
    // decision. FolderNameFor is also null for every record with no top-level group of its own,
    // which the message names.
    private static RecordEditResult? RefuseIfContainerType(string recordType, GameRelease release)
    {
        if (RecordTypeDispatch.For(release).FolderNameFor(recordType) is not null) return null;

        return RecordEditResult.Refused(
            RecordEditRefusal.ContainerRecordNotYetSupported,
            $"'{recordType}' has no source file of its own — it is a container record (Cell, Worldspace) " +
            "or a record embedded in one (a placed reference, landscape, navmesh, dialog topic, branch, " +
            "scene, response). Editing its fields works, and so do deleting and renumbering it; creating " +
            "one from scratch is not supported — a brand-new record has no containment for anything to " +
            "place it into.");
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
            $"'{recordType}' lives inside a container's document (a dialog topic, a scene), and no readable " +
            "container document in the source plugin carries this record.");
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

        var blockDirectory = FindOrMintGroupDirectory(cellsDirectory, "InteriorCellBlock");
        var subBlockDirectory = FindOrMintGroupDirectory(blockDirectory, "InteriorCellSubBlock");

        return [Path.GetFileName(blockDirectory), Path.GetFileName(subBlockDirectory)];
    }

    private static string FindOrMintGroupDirectory(string parentDirectory, string groupType)
    {
        var existing = Directory.EnumerateDirectories(parentDirectory).FirstOrDefault();
        if (existing != null) return existing;

        var directory = Path.Combine(parentDirectory, "0");
        SourceUnitResolver.InMintedDirectory(directory, () => WriteMinimalGroupRecordDataIfMissing(directory, groupType));
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

    /// <summary>Falls back to the indexed body only when the file is missing (never assume exclusive
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

    /// <summary>Writes the record's file at its placement, minting the directories above it and
    /// removing them again if the write throws.</summary>
    internal static string WriteAt(string modFolder, SourcePlacement placement, Func<string, string> write)
    {
        var path = Path.Combine(modFolder, placement.RelativePath);
        return SourceUnitResolver.InMintedDirectory(Path.GetDirectoryName(path)!, () => write(path));
    }

    /// <summary>Two serializations, one for the index and one for disk; <see cref="RecordTextCodec"/>
    /// producing identical bytes for both is what makes what the index is told and what lands the same text.</summary>
    internal static string SerializeAndWrite(RecordTextCodec codec, IMajorRecord record, string path, GameRelease release)
    {
        var bytes = codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();
        codec.SerializeAsync(record, path, release).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(bytes);
    }
}
