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
using Mutagen.Bethesda.Plugins.Meta;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

/// <summary>The single write path (ADR-0041): a field edit on a tracked plugin becomes a working-tree
/// change to the record's source JSON. The source text is the source, not the index; every
/// refusal precedes any write.</summary>
public sealed class RecordEditService(
    LoadOrderHolder loadOrder,
    Func<LoadOrder, FormLinkResolver> resolvers,
    IModImporter importer,
    RecordTextCodec codec,
    SchemaReflector schemaReflector,
    ILogger<RecordEditService> logger)
{
    // RecordCopy shares this instance's schema and codec so its writes are indistinguishable from
    // this class's own (ADR-0041's one write path).
    private readonly RecordCopy _recordCopy = new(schemaReflector, logger, codec);

    /// <summary>The single write path (ADR-0041): one envelope, patched onto the record's document
    /// by <see cref="DocumentEdit"/>, landed here as a working-tree change. This method owns only
    /// the IO around that.</summary>
    public RecordEditResult Edit(PluginKey plugin, string formKey, RecordEditEnvelope envelope)
    {
        if (ResolveEditTarget(plugin, formKey, out var editTarget) is { } blocked) return blocked;
        var (release, identity, unit, repository) = editTarget;
        var spelled = RecordEditEnvelope.Spell(envelope.Path);

        var schemas = schemaReflector.GetSchemas(release);
        if (!schemas.TryGetValue(identity.RecordType, out var schema))
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.FieldNotFound, spelled, $"'{identity.RecordType}' is not an editable record type.");
        }
        if (RefuseIfContainmentField(identity.RecordType, envelope.Path, schemas, release) is { } containmentRefusal)
            return containmentRefusal;

        // An embedded child is patched inside the document that carries it, so the identity written
        // back is that document's — its own for every other shape, the header included.
        var written = unit.IsEmbedded ? repository.IdentityOf(plugin, unit.OwnerFormKey, schemas) : identity;
        if (written is not { } target || repository.Get(plugin, target) is not { } document)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.SourceUnitNotFound,
                $"{unit.RelativePath} does not hold {formKey} — it was moved or removed outside " +
                "Modbench. Check the Source Control panel.");
        }

        // The parent is what the file holds and what the codec reads, so every untouched byte of it
        // comes back intact.
        var text = document.Body;
        IReadOnlyList<PathHop> prefix = [];
        if (unit.IsEmbedded)
        {
            var parentType = RecordTypeDispatch.For(release).ConcreteFor(target.RecordType);
            var found = parentType == null
                ? null
                : EmbeddedChildPath.Find((JsonObject)JsonNode.Parse(text)!, ContainerChildFields.NormalizedTypeName(parentType), formKey);
            if (found == null)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    // Deliberately does not blame an external change: a defect reads identically, and a
                    // wrong explanation sends the user hunting a problem that is not there.
                    $"{unit.RelativePath} was found holding {formKey}, but its own text does not " +
                    "carry it. If nothing outside Modbench changed that file, this is a defect — please " +
                    "report it; otherwise relaunch mEdit so the index re-reads the tree.");
            }
            prefix = found;
        }

        Func<string, string> roundTrip = schema.IsHeader
            ? patched => Encoding.UTF8.GetString(HeaderDocument.Write(HeaderDocument.Read(Encoding.UTF8.GetBytes(patched))))
            : patched => codec.RoundTrip(patched, release, unit.OwnerRecordType);

        // One resolver per gesture over the load order as it stands now, so every link in this record
        // is answered from one reading of the tree and none outlives the write.
        using var resolver = resolvers(loadOrder.Current);
        var request = new DocumentEditRequest(text, prefix, schema, envelope, release, resolver.Resolve, roundTrip);

        string newText;
        RecordEditResult? refused;
        try
        {
            refused = DocumentEdit.Patch(request, out newText);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // A document JsonDocument tolerates and JsonNode does not — duplicate members, most of
            // them — never reaches the codec, and this is the only reader that sees why.
            return RefuseUnreadable(formKey, ex.Message, spelled);
        }
        // The codec rejected the patched document; whether the unpatched one reads decides whose fault
        // that is, and it is only asked once an edit has already failed.
        if (refused is { Refusal: RecordEditRefusal.CodecRejected } && Unreadable(roundTrip, text) is { } why)
            return RefuseUnreadable(formKey, why, spelled);
        if (refused is { } rejected) return rejected;

        // The document already said this (a value set to itself): nothing to commit, so no dirty file
        // or history entry.
        if (string.Equals(newText, text, StringComparison.Ordinal)) return RecordEditResult.Success();

        // The leaf name carries the EditorID, so an EditorID edit is a rename too. Done before the
        // write; newText is the written document's own text, so its root EditorID is the new name.
        var newEditorId = EditorIdOf(newText);
        if (repository.Rename(plugin, target, newEditorId) is { } newLeaf && logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "EditorID changed on {FormKey}; moved its source unit from {Old} to {New}",
                target.FormKey, target.EditorId, newLeaf);
        }
        repository.Put(plugin, new SourceDocument(target.FormKey, target.RecordType, newEditorId, newText));

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Edited {Op} {Path} on {FormKey} in {Plugin} ({Origin}) — working-tree change written to {SourcePath}",
                envelope.Op, spelled, formKey, plugin.Name, plugin.Origin, unit.RelativePath);
        }
        return RecordEditResult.Success();
    }

    // Parse status is not a precondition (ADR-0046 invariant 7): the codec is asked at edit time, and
    // its own words are the reason.
    private static RecordEditResult RefuseUnreadable(string formKey, string why, string? spelled = null) =>
        new(false, RecordEditRefusal.RecordParseFailed,
            $"{formKey}'s document cannot be read, so nothing can be written to it: {why}", Path: spelled);

    private static string? Unreadable(Func<string, string> roundTrip, string text)
    {
        try
        {
            roundTrip(text);
            return null;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return ex.Message;
        }
    }

    private static string? EditorIdOf(string text)
    {
        using var document = JsonDocument.Parse(text);
        return document.RootElement.TryGetProperty(nameof(IMajorRecordGetter.EditorID), out var editorId)
            && editorId.ValueKind == JsonValueKind.String
            ? editorId.GetString()
            : null;
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
                "'position' is copied into the placement index (which cell a reference is in, and " +
                "where) — nothing on this path re-derives that side table, so a placed reference's " +
                "position is not writable through a field edit.");
        }

        return null;
    }

    /// <summary>A working-tree deletion: gone at Effective, still served at Head until compiled. No
    /// reference cascade; a dangling FormLink surfaces as an ordinary compile diagnostic (ADR-0041).
    /// Every record shape resolves through <see cref="SourceRepository.Locate"/>.</summary>
    public RecordEditResult DeleteRecord(PluginKey plugin, string formKey)
    {
        if (ResolveEditTarget(plugin, formKey, out var target) is { } blocked) return blocked;
        var (_, identity, unit, repository) = target;
        if (RefuseIfHeader(identity.RecordType) is { } headerRefusal) return headerRefusal;

        // One changed document either way: the owner without the child, or the record's own gone.
        // Every descendant's row follows from that when the projector re-reads it.
        var removal = repository.Remove(plugin, identity);
        if (removal != SourceRemoval.Removed)
        {
            // States only what is observed: either the tree names no document for it, or the document
            // it names lacks it.
            var observed = removal == SourceRemoval.NoDocumentHoldsIt
                ? $"No document in {plugin.Name}'s tree holds {formKey}."
                : $"{unit.RelativePath} was found holding {formKey}, but its own text does not carry it.";
            return RecordEditResult.Refused(
                RecordEditRefusal.SourceUnitNotFound,
                $"{observed} If nothing outside Modbench changed that file, this is a defect — please " +
                "report it; otherwise relaunch mEdit so the index re-reads the tree.");
        }

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
        if (RefuseIfBlocked(plugin, out _, out var repository) is { } blocked) return blocked;

        var release = loadOrder.Current.GameRelease;
        var schemas = schemaReflector.GetSchemas(release);
        if (recordType == PluginHeader.RecordType || !schemas.TryGetValue(recordType, out var schema))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordTypeNotFound, $"'{recordType}' is not a creatable record type.");
        }
        if (RefuseIfContainerType(recordType, release) is { } containerRefusal) return containerRefusal;

        if (ResolveTargetFormKey(AllocatorOver(repository, plugin), requestedFormKey, out var targetFormKey)
            is { } refusedTarget) return refusedTarget;

        var record = BareRecord(
            codec, schema, release, targetFormKey, string.IsNullOrWhiteSpace(editorId) ? null : editorId, partialForm: false);

        // RefuseIfContainerType guarantees a flat record, so the repository's own layout is the whole
        // answer: no block path, and the group folder minted by the write when this type is new here.
        repository.Put(
            plugin, new SourceDocument(targetFormKey, recordType, record.EditorID, SerializeToText(record, release)));

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Created {RecordType} {FormKey} in {Plugin} ({Origin}) — new working-tree source document",
                recordType, targetFormKey, plugin.Name, plugin.Origin);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    /// <summary>xEdit's "Copy as Override Into…" (ADR-0041): the source's own bytes land verbatim
    /// under the same FormKey. The master dependency is derived at compile (ADR-0038).</summary>
    public RecordEditResult CopyRecordAsOverride(PluginKey sourcePlugin, string formKey, PluginKey destinationPlugin)
    {
        if (ResolveCopySource(destinationPlugin, sourcePlugin, formKey, out var copy) is { } blocked) return blocked;
        using var source = copy.Source;
        return CopyAsOverride(copy, destinationPlugin);
    }

    private RecordEditResult CopyAsOverride(CopyTarget copy, PluginKey destinationPlugin)
    {
        var (source, identity, destination, release, body) = copy;
        var formKey = identity.FormKey;
        if (RefuseIfUnderride(formKey, destinationPlugin) is { } underrideRefusal) return underrideRefusal;

        // A record a container's document carries lands inside the destination's copy of that
        // document (the container rule); the refusal below is for a record with no group of its own
        // that no container document carries.
        if (RecordTypeDispatch.For(release).GroupFolderNameFor(identity.RecordType) is null
            && source.ContainerOf(identity) is { } container)
        {
            return _recordCopy.CopyEmbeddedChildAsOverride(
                source, formKey, source.Record(identity), container, destination, release);
        }

        if (RefuseIfCopySourceHasNoContainerOfItsOwn(identity.RecordType, release) is { } containerRefusal)
            return containerRefusal;

        var isContainer = IsContainerType(identity.RecordType, release);
        if (destination.Repository.HoldsAtEitherRef(destinationPlugin, formKey))
        {
            // A destination already overriding the explicitly-selected container record gets it
            // replaced, own-fields-only (xEdit's copy-into behavior). Every other record still
            // refuses, as does a record held only at Head.
            if (isContainer && _recordCopy.Identity(destination, formKey, release) is { } existingTarget)
                return ReplaceExplicitContainerCopyTarget(source, identity, existingTarget, destination, release);

            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{formKey} is already held by a record in {destinationPlugin.Name} at some ref.");
        }

        // IsInterior is false for both a genuine SubCells cell and a Worldspace's TopCell
        // (PlacementWalker hardcodes it). Only the SubCells case has block coordinates to mint from; a
        // TopCell falls through to the refusal, its placement being a follow-up.
        var isCell = IsCellType(identity.RecordType, release);
        var placement = isCell ? source.CellPlacementOf(identity) : null;
        if (isCell && placement?.IsInterior == false && placement.Value.BlockX != null)
        {
            var cellRecord = source.Record(identity);
            ContainerChildFields.ClearAllChildSlots(cellRecord);
            var mintResult = _recordCopy.MintExteriorCell(
                source, formKey, placement.Value, cellRecord, destination, release);
            if (mintResult.Applied && logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation(
                    "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into " +
                    "{DestinationPlugin} ({DestinationOrigin}) — minted its worldspace as a Partial Form ancestor",
                    formKey, source.Plugin.Name, source.Plugin.Origin, destinationPlugin.Name, destinationPlugin.Origin);
            }
            return mintResult;
        }
        if (isCell && placement?.IsInterior != true)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.ContainerParentMissingInDestination,
                $"{formKey} is an exterior cell with no worldspace grid position of its own — a worldspace's " +
                $"persistent cell, not one of its numbered blocks — so Copy as Override cannot create it in " +
                $"{destinationPlugin.Name}.");
        }

        // A plain Copy as Override is own-fields-only, so a container's inline children are stripped.
        if (isContainer) body = StripEmbeddedChildrenForShallowCopy(body, identity.RecordType, release);

        // A Cell's block bucket is the one thing resolved first, because it is chosen (or minted)
        // rather than derived.
        var written = SourceRepository.PlacementFor(
            destinationPlugin.Name, identity.RecordType, formKey, identity.EditorId, release,
            isCell ? EnsureInteriorCellBlockPath(destination.ModFolder, destinationPlugin.Name, release) : null);
        WriteAt(destination.ModFolder, written, path =>
        {
            SourceRepository.WriteTextAtomic(path, body);
            return body;
        });

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — new working-tree source file at {SourcePath}",
                formKey, source.Plugin.Name, source.Plugin.Origin, destinationPlugin.Name, destinationPlugin.Origin,
                written.RelativePath);
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
        if (ResolveCopySource(destinationPlugin, sourcePlugin, formKey, out var copy) is { } blocked) return blocked;
        using var source = copy.Source;
        return CopyAsNewRecord(copy, destinationPlugin, requestedFormKey);
    }

    private RecordEditResult CopyAsNewRecord(
        CopyTarget copy, PluginKey destinationPlugin, string? requestedFormKey)
    {
        var (source, identity, destination, release, _) = copy;
        var formKey = identity.FormKey;
        if (RefuseIfDisallowedForCopyAsNewRecord(identity.RecordType) is { } disallowedRefusal) return disallowedRefusal;

        // A record with no group of its own copies into its container's document (a topic into its
        // quest, a response into its topic); a placed reference has no such container and refuses.
        if (RecordTypeDispatch.For(release).FolderNameFor(identity.RecordType) is null)
        {
            if (source.ContainerOf(identity) is { } container)
                return CopyEmbeddedChildAsNewRecord(copy, container, destinationPlugin, requestedFormKey);
            if (RefuseIfContainerType(identity.RecordType, release) is { } containerRefusal) return containerRefusal;
        }

        if (ResolveTargetFormKey(
                AllocatorOver(destination.Repository, destinationPlugin), requestedFormKey, out var targetFormKey)
            is { } refusedTarget) return refusedTarget;

        var newRecord = source.Record(identity).Duplicate(FormKey.Factory(targetFormKey));
        RemapSelfLink(newRecord, formKey, targetFormKey);

        // Own-record-only, like Copy as Override: a container's children never ride along (deep copy
        // is a separate operation).
        ContainerChildFields.ClearAllChildSlots(newRecord);
        var placement = SourceRepository.PlacementFor(
            destinationPlugin.Name, identity.RecordType, targetFormKey, newRecord.EditorID, release);
        WriteAt(destination.ModFolder, placement, path => SerializeAndWrite(codec, newRecord, path, release));

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as new record {NewFormKey} into " +
                "{DestinationPlugin} ({DestinationOrigin}) — new working-tree source file at {SourcePath}",
                formKey, source.Plugin.Name, source.Plugin.Origin, targetFormKey, destinationPlugin.Name,
                destinationPlugin.Origin, placement.RelativePath);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    // The destination's embedded children are transplanted onto the replacing record so the copy
    // cannot delete them. An EditorID difference renames the unit, since the round-trip gate
    // regenerates canonical names.
    private RecordEditResult ReplaceExplicitContainerCopyTarget(
        CopySource source, RecordIdentity identity, RecordIdentity existingTarget,
        RecordCopy.Destination destination, GameRelease release)
    {
        var unit = destination.Repository.Locate(destination.Plugin, existingTarget)
            ?? throw new InvalidOperationException(
                $"{destination.Plugin.Name} holds {identity.FormKey}, but no document in its source tree carries it.");

        var replacement = source.Record(identity);
        ContainerChildFields.ClearAllChildSlots(replacement);
        var destinationRecord = codec
            .DeserializeAsync(unit.FullPath, release, unit.OwnerRecordType).GetAwaiter().GetResult();
        ContainerChildFields.TransplantChildSlots(destinationRecord, replacement);

        // Move first, then write: a crash between leaves the leaf at its new name with old content,
        // still findable by FormKey. The reverse order leaves two units claiming one FormKey.
        destination.Repository.Rename(destination.Plugin, existingTarget, replacement.EditorID);
        destination.Repository.Put(
            destination.Plugin,
            new SourceDocument(
                identity.FormKey, existingTarget.RecordType, replacement.EditorID, SerializeToText(replacement, release)));

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — replaced the existing override's own fields in place",
                identity.FormKey, source.Plugin.Name, source.Plugin.Origin, destination.Plugin.Name,
                destination.Plugin.Origin);
        }
        return RecordEditResult.Success();
    }

    // The embedded subtree rides along, each record under a fresh key drawn before anything is written.
    // Links between copied siblings are not remapped, xEdit's own behavior. A missing container chain
    // auto-creates bare and Partial Form.
    private RecordEditResult CopyEmbeddedChildAsNewRecord(
        CopyTarget copy, CopySource.Containment container, PluginKey destinationPlugin, string? requestedFormKey)
    {
        var (source, identity, destination, release, _) = copy;

        var allocator = AllocatorOver(destination.Repository, destinationPlugin);
        if (ResolveTargetFormKey(allocator, requestedFormKey, out var targetFormKey) is { } refusedTarget)
            return refusedTarget;

        // Its own text carries its whole embedded subtree, so the codec has already read every
        // descendant by the time one can be re-keyed.
        var newRecord = source.Record(identity).Duplicate(FormKey.Factory(targetFormKey));
        RemapSelfLink(newRecord, identity.FormKey, targetFormKey);

        var taken = new HashSet<string>(StringComparer.Ordinal) { targetFormKey };
        if (RekeyEmbeddedDescendants(allocator, newRecord, taken) is { } childRefused) return childRefused;

        var appended = _recordCopy.AppendEmbeddedChild(
            source, container.ParentFormKey, container.ParentRecordType, container.SlotName, newRecord,
            destination, release);
        if (!appended.Applied) return appended;

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as new record {NewFormKey} into " +
                "{DestinationPlugin} ({DestinationOrigin}) — inside {ContainerFormKey}'s {SlotName} slot, " +
                "with {DescendantCount} embedded descendant(s) each under a fresh FormKey",
                identity.FormKey, source.Plugin.Name, source.Plugin.Origin, targetFormKey, destinationPlugin.Name,
                destinationPlugin.Origin, container.ParentFormKey, container.SlotName, taken.Count - 1);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    // In place, on the duplicate's own graph: the list order is untouched, and a child's own
    // embedded children are re-keyed the same way one level down.
    private static RecordEditResult? RekeyEmbeddedDescendants(
        Allocator allocator, IMajorRecordGetter container, HashSet<string> taken)
    {
        var containerType = ContainerChildFields.NormalizedTypeName(container.GetType());
        foreach (var (slotName, _, child) in ContainerChildFields.EnumerateChildren(container).ToList())
        {
            if (!ContainerChildFields.EmbeddedSlots.Contains((containerType, slotName))) continue;
            if (ResolveTargetFormKey(allocator, requestedFormKey: null, out var childFormKey, taken) is { } refused)
                return refused;
            taken.Add(childFormKey);

            var oldFormKey = child.FormKey.ToString();
            ((IMajorRecordInternal)child).FormKey = FormKey.Factory(childFormKey);
            RemapSelfLink(child, oldFormKey, childFormKey);
            if (RekeyEmbeddedDescendants(allocator, child, taken) is { } deeper) return deeper;
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
        var copies = loadOrder.Current.Copies;

        // A FormKey carries only a filename, so with two same-named copies (ADR-0036) the winning one
        // is the origin.
        var originName = FormKey.Factory(formKey).ModKey.FileName.String;
        var sameNamed = copies.Where(p => p.Name.Equals(originName, StringComparison.OrdinalIgnoreCase)).ToList();
        var originIndex = (sameNamed.FirstOrDefault(p => p.Winning) ?? sameNamed.FirstOrDefault())?.Slot;
        var destinationIndex = copies.FirstOrDefault(
            p => p.Name.Equals(destinationPlugin.Name, StringComparison.OrdinalIgnoreCase)
                && p.Origin.Equals(destinationPlugin.Origin, StringComparison.Ordinal))?.Slot;
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
    internal static bool IsContainerType(string recordType, GameRelease release) =>
        RecordTypeDispatch.For(release).ConcreteFor(recordType) is { } concrete
        && ContainerChildFields.EnumerateChildFieldsFor(concrete) != null;

    /// <summary>Whether this record type is the game's cell — the one type whose place in the world is
    /// its directory rather than a slot.</summary>
    internal static bool IsCellType(string recordType, GameRelease release) =>
        RecordTypeDispatch.For(release).ConcreteFor(recordType)?.Name == "Cell";

    /// <summary>A delete+create pair in source terms plus a reference cascade. Native records only; an
    /// untracked referencer refuses before any write. Computed whole, then written through a
    /// <see cref="SourceTransaction"/> that restores every tree on failure (ADR-0045).</summary>
    public RecordEditResult RenumberRecord(PluginKey plugin, string formKey, string? requestedFormKey = null)
    {
        if (ResolveEditTarget(plugin, formKey, out var target) is { } blocked) return blocked;
        var (release, identity, unit, repository) = target;
        if (RefuseIfHeader(identity.RecordType) is { } headerRefusal) return headerRefusal;

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

        if (ResolveTargetFormKey(AllocatorOver(repository, plugin), requestedFormKey, out var targetFormKey)
            is { } refusedTarget) return refusedTarget;

        var (referencers, untrackedReferencers) =
            new ReferencerScan(loadOrder.Current, importer, codec, schemaReflector, logger).Of(formKey, plugin);
        if (untrackedReferencers.Count > 0)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.UntrackedReferencer,
                $"{formKey} is referenced by untracked plugin(s) {string.Join(", ", untrackedReferencers)}, " +
                "so the renumber cannot rewrite their FormLinks. Track them first, then try again.");
        }

        // Phase one: nothing below this point touches the filesystem. Any refusal it returns is
        // returned with the tree exactly as this method found it.
        if (ComputeReferencerRewrites(formKey, targetFormKey, release, referencers, out var rewrites)
            is { } refusedReferencer) return refusedReferencer;
        if (ComputeTargetRewrite(plugin, repository, identity, unit, formKey, targetFormKey, release, out var targetRewrite)
            is { } refusedSelf) return refusedSelf;

        // Phase two: everything that can still fail is genuine I/O, recorded in one transaction
        // (ADR-0045).
        var transaction = new SourceTransaction();
        try
        {
            foreach (var rewrite in rewrites) WriteComputedRewrite(transaction, rewrite, release);
            WriteTargetRewrite(transaction, plugin, targetRewrite, targetFormKey, release);
        }
        catch (Exception ex)
        {
            // Unfiltered so an unexpected fault is rolled back and disclosed rather than falling
            // through to the endpoint's InvalidOperationException handler ("no usable load order").
            // Rethrown as IOException so it reaches the client as the same 500 every write fault does.
            throw new IOException(RollBackFailedRenumber(transaction, plugin, rewrites, formKey, targetFormKey, ex), ex);
        }

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Renumbered {OldFormKey} to {NewFormKey} in {Plugin} ({Origin}), rewriting {Count} referencing record(s)",
                formKey, targetFormKey, plugin.Name, plugin.Origin, referencers.Count);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    // Only the trees are put back (ADR-0045); the Source watcher lands the restored files. Paths
    // are relative to the mod folder, the form the Source Control panel lists.
    private string RollBackFailedRenumber(
        SourceTransaction transaction, PluginKey plugin, IReadOnlyList<ComputedRewrite> rewrites,
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

        var modFolders = rewrites.Select(r => r.ModFolder).Append(ModFolders.Of(loadOrder.Current, plugin))
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
    // Owner is the document's own identity, Record the graph its whole text serializes from.
    private sealed record ComputedRewrite(
        PluginKey Plugin, SourceRepository Repository, RecordIdentity Owner, IMajorRecord Record)
    {
        internal string ModFolder => Repository.ModFolder;
    }

    // One document at a time, which is what the scan answers with: a container holding several
    // referencers is remapped once. The typed remap moves links and only links, and the
    // remap-completeness guard below covers its one gap.
    private RecordEditResult? ComputeReferencerRewrites(
        string oldFormKey, string newFormKey, GameRelease release,
        IReadOnlyList<ReferencerScan.Referencing> referencers,
        out List<ComputedRewrite> rewrites)
    {
        rewrites = [];
        var mapping = RenumberMapping(oldFormKey, newFormKey);
        var schemas = schemaReflector.GetSchemas(release);

        foreach (var (referencerPlugin, referencerRepository, document, schemaType, embeddedFormKeys) in referencers)
        {
            // Asked before the codec is: a document the scan could not run the collector over is one
            // this pass cannot read either, and a guard that cannot run has cleared nothing.
            if (schemaType is null)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.ReferenceRemapIncomplete,
                    $"A document in {referencerPlugin.Name}'s tree naming {document.FormKey} could not be " +
                    $"read, so whether it links {oldFormKey} cannot be answered. Nothing was written.");
            }
            if (!schemas.ContainsKey(schemaType))
                return RefuseNoSchema(document.FormKey, schemaType, referencerPlugin);

            var owner = ReadDocument(codec, document, release);
            ((IFormLinkContainer)owner).RemapLinks(mapping);
            if (RefuseIfRemapIncomplete(owner, schemaType, oldFormKey, referencerPlugin, release) is { } incomplete)
                return incomplete;

            foreach (var embeddedFormKey in embeddedFormKeys)
            {
                // A remap never moves a record's own FormKey, so the child is still found under it.
                if (ContainerChildFields.FindEmbeddedChild(owner, embeddedFormKey)?.Child is not { } child) continue;

                // The owner's own walk never reaches a child's VMAD — an embedded referencer's
                // struct-list link is its own record's, and has to be asked of the child directly.
                if (RefuseIfRemapIncomplete(
                        child, SourceRecordType.Resolve(child, schemas), oldFormKey, referencerPlugin, release)
                    is { } childIncomplete) return childIncomplete;
            }

            // Carried rather than recomputed at write time: the transaction names unrestored paths
            // relative to this repository's folder.
            rewrites.Add(new ComputedRewrite(
                referencerPlugin, referencerRepository,
                new RecordIdentity(document.FormKey, schemaType, document.EditorId), owner));
        }

        return null;
    }

    // The guard's conservative direction: a guard that cannot run has cleared nothing, so a document
    // whose type the schema does not name stops the gesture rather than being passed over.
    private static RecordEditResult RefuseNoSchema(string formKey, string recordType, PluginKey plugin) =>
        RecordEditResult.Refused(
            RecordEditRefusal.ReferenceRemapIncomplete,
            $"'{recordType}' has no reflected schema, so the remap-completeness check for " +
            $"{formKey} in {plugin.Name} could not run. Nothing was written.");

    private static Dictionary<FormKey, FormKey> RenumberMapping(string oldFormKey, string newFormKey) =>
        new() { [FormKey.Factory(oldFormKey)] = FormKey.Factory(newFormKey) };

    private string SerializeToText(IMajorRecordGetter record, GameRelease release) =>
        Encoding.UTF8.GetString(codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult());

    // A link the typed remap left behind is refused wherever it sits; a KnownDefects row is what
    // names the member Mutagen is known to skip. Asked of the collector: text cannot tell a link
    // from an EditorID or string.
    private RecordEditResult? RefuseIfRemapIncomplete(
        IMajorRecordGetter record, string recordType, string oldFormKey, PluginKey plugin, GameRelease release)
    {
        if (!schemaReflector.GetSchemas(release).TryGetValue(recordType, out var schema))
            return RefuseNoSchema(record.FormKey.ToString(), recordType, plugin);

        List<FormReference> refs;
        using (var document = JsonDocument.Parse(SerializeToText(record, release)))
            refs = FormReferences.Collect(document.RootElement, schema);
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
    private string WhyRemapIsIncomplete(FormReference stale, GameRelease release) =>
        schemaReflector.DefectsWith(release, KnownDefectEffect.RenumberRemapIncomplete)
            .FirstOrDefault(d => stale.FieldPath.Split(PathHopSeparators).Contains(d.MemberName, StringComparer.Ordinal))
            is { } defect
                ? $"{defect.TypeName}.{defect.MemberName}: {defect.Reason}."
                : "No known-defect row names a member Mutagen's generated remap skips, so the cause is unknown.";

    // A referencer's remapped graph is its owning document's whole text, so the batch takes it as one
    // put against that document's own identity.
    private void WriteComputedRewrite(SourceTransaction transaction, ComputedRewrite rewrite, GameRelease release)
    {
        transaction.Put(
            rewrite.Repository, rewrite.Plugin,
            new SourceDocument(
                rewrite.Owner.FormKey, rewrite.Owner.RecordType, rewrite.Owner.EditorId,
                SerializeToText(rewrite.Record, release)));
    }

    // Root is the whole record the target's own document serializes from: the owner when embedded,
    // and Written is that document's identity. Held is the target's own identity, as the tree has it.
    private sealed record ComputedTarget(
        SourceRepository Repository, SourceUnit Unit, RecordIdentity Written, RecordIdentity Held,
        IMajorRecord Root);

    // The referencer pass skips the target, so this is the only place a self-link is remapped.
    // Nothing here writes; every failure mode is a typed refusal.
    private RecordEditResult? ComputeTargetRewrite(
        PluginKey plugin, SourceRepository repository, RecordIdentity identity, SourceUnit unit,
        string oldFormKey, string newFormKey, GameRelease release, out ComputedTarget target)
    {
        target = null!;
        var mapping = RenumberMapping(oldFormKey, newFormKey);
        var schemas = schemaReflector.GetSchemas(release);

        if (unit.IsEmbedded)
        {
            if (repository.IdentityOf(plugin, unit.OwnerFormKey, schemas) is not { } ownerIdentity
                || repository.Get(plugin, ownerIdentity) is not { } ownerDocument)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    $"No document in {plugin.Name}'s tree holds {unit.OwnerFormKey}, the record " +
                    $"{unit.RelativePath} carries {oldFormKey} inside. Nothing was written.");
            }

            var owner = ReadDocument(codec, ownerDocument, release);
            if (ContainerChildFields.FindEmbeddedChild(owner, oldFormKey) is not { } found)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.SourceUnitNotFound,
                    $"{unit.RelativePath} was found holding {oldFormKey}, but its own text does not carry it. " +
                    "Nothing was written.");
            }

            // Remapped on the owner, not the child: a sibling embedded in the same document may hold
            // the self-link, and its own file is this same one.
            ((IFormLinkContainer)owner).RemapLinks(mapping);

            // Guarded before the new FormKey is stamped on, so a refusal names the record the user
            // asked about.
            if (RefuseIfRemapIncomplete(owner, ownerIdentity.RecordType, oldFormKey, plugin, release) is { } ownerIncomplete)
                return ownerIncomplete;
            if (RefuseIfRemapIncomplete(found.Child, identity.RecordType, oldFormKey, plugin, release) is { } childIncomplete)
                return childIncomplete;

            ((IMajorRecordInternal)found.Child).FormKey = FormKey.Factory(newFormKey);

            target = new ComputedTarget(repository, unit, ownerIdentity, identity, owner);
            return null;
        }

        if (repository.Get(plugin, identity) is not { } document)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.SourceUnitNotFound,
                $"No source unit in {plugin.Name}'s tree holds {oldFormKey}. Nothing was written.");
        }

        var record = ReadDocument(codec, document, release);
        ((IFormLinkContainer)record).RemapLinks(mapping);

        if (RefuseIfRemapIncomplete(record, identity.RecordType, oldFormKey, plugin, release) is { } recordIncomplete)
            return recordIncomplete;

        ((IMajorRecordInternal)record).FormKey = FormKey.Factory(newFormKey);

        target = new ComputedTarget(
            repository, unit, new RecordIdentity(newFormKey, identity.RecordType, identity.EditorId),
            identity, record);
        return null;
    }

    /// <summary>The document's own graph, read back through the codec by the type its text names —
    /// a path-ambiguous group's document names its own class, which is the codec's spelling, not the
    /// schema's table.</summary>
    internal static IMajorRecord ReadDocument(RecordTextCodec codec, SourceDocument document, GameRelease release) =>
        codec.DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body), release, document.RecordType)
            .GetAwaiter().GetResult();

    private void WriteTargetRewrite(
        SourceTransaction transaction, PluginKey plugin, ComputedTarget target, string newFormKey,
        GameRelease release)
    {
        var (repository, unit, written, held, root) = target;
        var text = SerializeToText(root, release);

        // No file moves for an embedded record — it has no leaf name of its own — so the owner's own
        // document, reserialized around the child's new FormKey, is the whole write.
        if (unit.IsEmbedded)
        {
            transaction.Put(repository, plugin, new SourceDocument(written.FormKey, written.RecordType, written.EditorId, text));
            return;
        }

        // A container is moved whole rather than recreated from scratch: a worldspace's block subtree
        // travels with it rather than being orphaned, which no put-then-remove pair can express.
        if (unit.IsDirectoryPerRecord)
        {
            var oldLeafPath = Path.GetDirectoryName(unit.FullPath)!;
            var newLeafPath = Path.Combine(
                Path.GetDirectoryName(oldLeafPath)!,
                SourceRepository.LeafNameFor(FormKey.Factory(newFormKey), held.EditorId, isDirectory: true));

            transaction.Move(repository.ModFolder, oldLeafPath, newLeafPath);
            var writePath = Path.Combine(newLeafPath, SourceRepository.RecordDataFileName);
            transaction.Write(
                repository.ModFolder, writePath,
                () => codec.SerializeAsync(root, writePath, release).GetAwaiter().GetResult());
            return;
        }

        // Only the FormKey half of a flat record's leaf name changes, which the put's own placement
        // computes; the remove then takes the file the old FormKey named.
        transaction.Put(repository, plugin, new SourceDocument(written.FormKey, written.RecordType, written.EditorId, text));
        var removal = transaction.Remove(repository, plugin, held);

        // Both outcomes a flat record can answer leave the old leaf gone, which is the state this
        // renumber wants; the embedded-only third would mean the tree changed under the put.
        if (removal == SourceRemoval.OwnerDoesNotCarryIt)
            throw new IOException($"The document holding {held.FormKey} does not carry it, so the renumber cannot take it out.");
    }

    // Everything the allocator needs about one plugin, read from its tree once per gesture: a
    // per-child re-read would walk the whole tree again for every key drawn.
    private readonly record struct Allocator(
        PluginKey Plugin, GameRelease Release, bool IsLight, bool EslFlagIsRemovable,
        IReadOnlySet<string> Effective, IReadOnlySet<string> Head)
    {
        internal bool HoldsAtEitherRef(string formKey) => Effective.Contains(formKey) || Head.Contains(formKey);

        internal IEnumerable<string> Taken => Effective.Concat(Head);
    }

    // A tracked copy allocates from its source tree; an untracked one has none, so the Plugin
    // adapter answers from its own bytes, as the form-link resolver's untracked branch does.
    private Allocator AllocatorFor(RegisteredCopy copy, PluginKey plugin)
    {
        if (ModFolders.Of(loadOrder.Current, plugin) is { } modFolder
            && SourceRepository.Open(modFolder, loadOrder.Current.GameRelease) is { } repository)
        {
            return AllocatorOver(repository, plugin);
        }

        using var opened = importer.Open(copy, loadOrder.Current.GameRelease);
        return AllocatorOver(opened.Getter, plugin);
    }

    // Both refs from the tree alone (ADR-0046 invariant 7): the working tree, plus HEAD, whose IDs a
    // working-tree deletion has not freed until the plugin is compiled.
    private Allocator AllocatorOver(SourceRepository repository, PluginKey plugin)
    {
        var byRemovableFlag = IsLightByRemovableFlag(repository, plugin);
        return new Allocator(
            plugin,
            loadOrder.Current.GameRelease,
            byRemovableFlag || plugin.Name.EndsWith(".esl", StringComparison.OrdinalIgnoreCase),
            byRemovableFlag,
            repository.NativeFormKeysHeld(plugin),
            repository.NativeFormKeysHeldAt(plugin, "HEAD"));
    }

    // The copy's own records are the whole answer: it has no uncompiled state, so no second ref.
    private Allocator AllocatorOver(IModGetter mod, PluginKey plugin) =>
        new(plugin,
            loadOrder.Current.GameRelease,
            PluginFlagPredicates.IsLight(mod, plugin.Name),
            mod.IsSmallMaster,
            mod.EnumerateMajorRecords()
                .Select(r => r.FormKey)
                .Where(k => k.ModKey.FileName.String.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase))
                .Select(k => k.ToString())
                .ToHashSet(StringComparer.OrdinalIgnoreCase),
            new HashSet<string>(StringComparer.OrdinalIgnoreCase));

    // Non-null is the refusal; targetFormKey is "" then, so call sites need no second null-check.
    // taken: keys this gesture drew but has not written, so one document's records get distinct keys.
    private static RecordEditResult? ResolveTargetFormKey(
        Allocator allocator, string? requestedFormKey, out string targetFormKey, IReadOnlySet<string>? taken = null)
    {
        var plugin = allocator.Plugin;
        if (requestedFormKey != null)
        {
            if (RefuseIfNotNativeTarget(requestedFormKey, plugin, allocator.IsLight) is { } notNative)
            {
                targetFormKey = "";
                return notNative;
            }
            if (allocator.HoldsAtEitherRef(requestedFormKey))
            {
                targetFormKey = "";
                return RecordEditResult.Refused(
                    RecordEditRefusal.FormKeyCollision,
                    $"{requestedFormKey} is already held by a record in {plugin.Name} at some ref.");
            }
            targetFormKey = requestedFormKey;
            return null;
        }

        var allocated = NextFreeNativeFormId(allocator, allocator.IsLight, taken);
        if (allocated != null)
        {
            targetFormKey = allocated;
            return null;
        }

        targetFormKey = "";
        // The ESL cap, not the FormKey space, is exhausted, and the light-ness is the removable header
        // flag: surfaced as a typed marker, the same way out compile offers.
        var eslContradiction = allocator.IsLight
            && allocator.EslFlagIsRemovable
            && NextFreeNativeFormId(allocator, isLight: false, taken) != null;
        return RecordEditResult.Refused(
            RecordEditRefusal.FormKeySpaceExhausted,
            FormKeySpaceExhaustedMessage(plugin, allocator.IsLight, eslContradiction),
            eslContradiction);
    }

    // The header document in the working tree is the truth (ADR-0041), so a flag flipped this session
    // caps minting immediately. A .esl extension also reads as light, but no header edit can un-flag it.
    private static bool IsLightByRemovableFlag(SourceRepository repository, PluginKey plugin)
    {
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name));
        var header = repository.Get(plugin, new RecordIdentity(headerFormKey, PluginHeader.RecordType, null));
        return header?.Body is { } body && HeaderDocument.IsLight(Encoding.UTF8.GetBytes(body));
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

    // Unions the working tree (committed plus uncompiled creates) and HEAD (natives the working tree
    // deleted, whose IDs must not be reused before compile). Null means exhausted.
    private static string? NextFreeNativeFormId(Allocator allocator, bool isLight, IReadOnlySet<string>? taken = null)
    {
        // GetDefaultInitialNextFormID is this constant for every mod of a release: its own default
        // argument takes the branch that returns the high range, loaded plugin or not.
        var floor = GameConstants.Get(allocator.Release).DefaultHighRangeFormID;
        var highest = allocator.Taken
            .Concat(taken ?? Enumerable.Empty<string>())
            .Select(LocalId)
            .DefaultIfEmpty(0u)
            .Max();
        var next = Math.Max(floor, highest + 1);
        var cap = isLight ? PluginFlagPredicates.LightLocalFormIdCap : FormID.FullIdMask;
        return next > cap ? null : $"{next:X6}:{allocator.Plugin.Name}";
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

    /// <summary>The allocator create and renumber use, exposed so the Renumber box can prefill a
    /// suggestion as xEdit does. A tracked copy answers from its tree and HEAD, an untracked one from
    /// its own binary.</summary>
    public RecordEditResult PeekNextFreeFormKey(PluginKey plugin)
    {
        // No snapshot yet is a state, not a refusal about this plugin.
        if (loadOrder.Current.Copies.Count == 0)
            return RecordEditResult.Refused(RecordEditRefusal.RecordNotFound, "No load order has been received.");

        // Never a write, so no write gate and no tracked gate: an untracked copy answers too. A copy
        // the load order does not register is the one left with nothing to answer from.
        if (loadOrder.Current.Copy(plugin) is not { } copy)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound,
                $"The load order does not hold {plugin.Name} ({plugin.Origin}).");
        }

        Allocator allocator;
        try
        {
            allocator = AllocatorFor(copy, plugin);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // Registered and unreadable: MO2 replaces and removes a copy's file whenever it likes, and
            // a read says so rather than faulting.
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordParseFailed,
                $"{plugin.Name} could not be read, so nothing can say which of its FormIDs are free: {ex.Message}");
        }

        var formKey = NextFreeNativeFormId(allocator, allocator.IsLight);
        return formKey != null
            ? RecordEditResult.Success(formKey)
            : RecordEditResult.Refused(
                RecordEditRefusal.FormKeySpaceExhausted, FormKeySpaceExhaustedMessage(plugin, allocator.IsLight));
    }

    /// <summary>The palette title verbatim (package.json's "Track…" under category "Modbench"); a signpost
    /// naming a command the user cannot find is worse than none.</summary>
    internal const string TrackCommandTitle = "Modbench: Track\u2026";

    private readonly record struct EditTarget(
        GameRelease Release, RecordIdentity Identity, SourceUnit Unit, SourceRepository Repository);

    // The working tree is the only thing asked (ADR-0046 invariant 7): a second edit builds on the
    // first, and no document comes from the Index. The copy gestures read the source instead.
    private RecordEditResult? ResolveEditTarget(PluginKey plugin, string formKey, out EditTarget target)
    {
        target = default;

        if (RefuseIfBlocked(plugin, out _, out var repository) is { } blocked) return blocked;

        var release = loadOrder.Current.GameRelease;
        RecordIdentity? found;
        try
        {
            found = repository.IdentityOf(plugin, formKey, schemaReflector.GetSchemas(release));
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // Naming this record means reading the document that carries it, and the codec is the only
            // reader of one: its own words are the reason.
            return RefuseUnreadable(formKey, ex.Message);
        }

        if (found is not { } identity)
        {
            // A document named after this record whose text is not one: present, so this is not
            // absence, and the reader's words are the whole reason.
            if (repository.UnreadableDocumentFor(plugin, formKey) is { } why) return RefuseUnreadable(formKey, why);

            return RecordEditResult.Refused(
                RecordEditRefusal.RecordNotFound,
                $"No document in {plugin.Name}'s source tree holds {formKey}, and no record's document " +
                "carries it.");
        }

        // An embedded child (a placed ref, landscape, navmesh, top cell) resolves to its parent's file.
        if (repository.Locate(plugin, identity) is not { } unit)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.SourceUnitNotFound,
                $"No document in {plugin.Name}'s source tree holds {formKey}, and no record's document " +
                "carries it. Something moved or removed it outside Modbench \u2014 check the Source Control panel.");
        }

        target = new EditTarget(release, identity, unit, repository);
        return null;
    }

    private readonly record struct CopyTarget(
        CopySource Source, RecordIdentity Identity, RecordCopy.Destination Destination, GameRelease Release, string Body);

    // Asymmetric by construction: the write-path gate checks the destination, the source answers for
    // its own record. The text is read before anything is written, because a record the codec cannot
    // read would land as a stub.
    private RecordEditResult? ResolveCopySource(
        PluginKey destinationPlugin, PluginKey sourcePlugin, string formKey, out CopyTarget target)
    {
        target = default;

        if (RefuseIfBlocked(destinationPlugin, out var destinationModFolder, out var destinationRepository)
            is { } blocked) return blocked;

        var release = loadOrder.Current.GameRelease;
        var source = new CopySource(sourcePlugin, loadOrder.Current, importer, codec, schemaReflector);
        try
        {
            if (source.Identity(formKey) is not { } identity)
            {
                source.Dispose();
                return RecordEditResult.Refused(
                    RecordEditRefusal.RecordNotFound, $"{sourcePlugin.Name} does not hold record {formKey}.");
            }

            target = new CopyTarget(
                source, identity,
                new RecordCopy.Destination(destinationRepository, destinationPlugin, destinationModFolder),
                release, source.Body(identity));
            return null;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            source.Dispose();
            return RefuseUnreadableCopySource(formKey, source.Diagnose(ex));
        }
    }

    // A record's own descendants are inside its text, so one unreadable response refuses its topic
    // here too.
    private static RecordEditResult RefuseUnreadableCopySource(string formKey, string why) =>
        RecordEditResult.Refused(
            RecordEditRefusal.RecordParseFailed,
            $"{formKey} cannot be read, so copying it would land a stub holding only its FormKey and " +
            $"EditorID rather than the record: {why}");

    // INVARIANT: every write gesture calls this first, and it is the only gate on tracked-ness.
    // Reaching the source tree any other way bypasses the deferral refusal entirely.
    private RecordEditResult? RefuseIfBlocked(PluginKey plugin, out string modFolder, out SourceRepository repository)
    {
        modFolder = "";
        repository = null!;

        if (ModFolders.Of(loadOrder.Current, plugin) is not { } folder) return RefuseUntracked(plugin);
        if (SourceRepository.Open(folder, loadOrder.Current.GameRelease) is not { } opened) return RefuseUntracked(plugin);

        (modFolder, repository) = (folder, opened);

        // Checked before anything else, so the source file is never reached.
        return ExternalChangeDeferral.Unanswered(folder, plugin.Name) is { } question
            ? RecordEditResult.Refused(RecordEditRefusal.ExternalChangeUnanswered, question)
            : null;
    }

    // Two refusals, because there are two different ways out and a message that named neither
    // would be silent dead UI.
    private RecordEditResult RefuseUntracked(PluginKey plugin) =>
        ModFolders.Of(loadOrder.Current, plugin) is null
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
        recordType == PluginHeader.RecordType
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
        var cellsDirectory = Path.Combine(modFolder, SourceRepository.RootFor(pluginName), cellsFolder);
        SourceRepository.InMintedDirectory(cellsDirectory, () => WriteMinimalGroupRecordDataIfMissing(cellsDirectory, groupType: null));

        var blockDirectory = FindOrMintGroupDirectory(cellsDirectory, "InteriorCellBlock");
        var subBlockDirectory = FindOrMintGroupDirectory(blockDirectory, "InteriorCellSubBlock");

        return [Path.GetFileName(blockDirectory), Path.GetFileName(subBlockDirectory)];
    }

    private static string FindOrMintGroupDirectory(string parentDirectory, string groupType)
    {
        var existing = Directory.EnumerateDirectories(parentDirectory).FirstOrDefault();
        if (existing != null) return existing;

        var directory = Path.Combine(parentDirectory, "0");
        SourceRepository.InMintedDirectory(directory, () => WriteMinimalGroupRecordDataIfMissing(directory, groupType));
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
        var path = Path.Combine(directory, SourceRepository.GroupRecordDataFileName);
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
        var record = codec.DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(body), release, recordType).GetAwaiter().GetResult();
        ContainerChildFields.ClearAllChildSlots(record);
        var stripped = codec.SerializeToBytesAsync(record, release).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(stripped);
    }

    /// <summary>Writes the record's file at its placement, minting the directories above it and
    /// removing them again if the write throws.</summary>
    internal static string WriteAt(string modFolder, SourcePlacement placement, Func<string, string> write)
    {
        var path = Path.Combine(modFolder, placement.RelativePath);
        return SourceRepository.InMintedDirectory(Path.GetDirectoryName(path)!, () => write(path));
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
