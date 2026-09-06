using System.Text;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

/// <summary>The container half of <see cref="RecordEditService.CopyRecordAsOverride"/>: a child lands
/// inside its container's document, minted bare and Partial Form when the destination lacks it.
/// Shares the service's mirror and schemaReflector: one write path (ADR-0041).</summary>
internal sealed class RecordCopy(ILoadOrderMirror mirror, SchemaReflector schemaReflector, ILogger logger, RecordTextCodec codec)
{
    /// <summary>The container whose document carries a child, and the slot member it sits in.</summary>
    internal readonly record struct Embedding(RecordDocument Container, string SlotName);

    /// <summary>The index names the container, and the container's own document says which slot.
    /// Null for a record no container's document carries, a folder-split child included.</summary>
    internal Embedding? EmbeddedContainerOf(IRecordReads reads, PluginKey plugin, string formKey, GameRelease release)
    {
        var containerFormKey = reads.GetPlacement(formKey, plugin)?.ParentCell
            ?? reads.GetContainerParent(plugin, formKey)?.ParentFormKey;
        if (containerFormKey == null || reads.GetDocument(containerFormKey, plugin) is not { ParseDiagnosis: null } container)
            return null;

        var containerRecord = codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(container.Body!), release, container.RecordType)
            .GetAwaiter().GetResult();
        return ContainerChildFields.FindEmbeddedChild(containerRecord, formKey) is { } found
            ? new Embedding(container, found.SlotName)
            : null;
    }

    /// <summary>Bare fields are xEdit parity; Partial Form is a deliberate mEdit divergence (xEdit
    /// leaves the ancestor unflagged; mEdit flags it so conflict detection ignores its stub fields).</summary>
    internal RecordEditResult CopyEmbeddedChildAsOverride(
        PluginKey sourcePlugin, string formKey, RecordDocument document, Embedding embedding,
        PluginKey destinationPlugin, string destinationModFolder, IRecordIndex index, GameRelease release)
    {
        if (!RecordEditService.IsFreeAtBothRefs(index, destinationPlugin, formKey))
        {
            // The explicitly-selected child already held at Effective is replaced in place, never
            // duplicated or refused. Held only at Head (deleted in the working tree) still refuses.
            if (index.At(RecordRef.Effective).GetDocument(formKey, destinationPlugin) != null)
            {
                return ReplaceEmbeddedChildInPlace(
                    sourcePlugin, formKey, document, destinationPlugin, destinationModFolder, index, release);
            }
            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{formKey} is already held by a record in {destinationPlugin.Name} at some ref.");
        }

        var reads = index.At(RecordRef.Effective);
        var containerFormKey = embedding.Container.FormKey;
        var childRecord = codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body!), release, document.RecordType)
            .GetAwaiter().GetResult();

        var destinationContainer = reads.GetDocument(containerFormKey, destinationPlugin);
        if (destinationContainer == null)
        {
            var bare = BarePartialFormAncestor(containerFormKey, embedding.Container.RecordType, release);
            ContainerChildFields.AddChildToSlot(bare, embedding.SlotName, childRecord);
            var minted = PlaceMintedContainer(
                sourcePlugin, containerFormKey, embedding.Container.RecordType, bare, destinationPlugin, destinationModFolder, index, release);
            if (minted.Applied && logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation(
                    "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                    "({DestinationOrigin}) — minted its container {ContainerFormKey} as a Partial Form ancestor around it",
                    formKey, sourcePlugin.Name, sourcePlugin.Origin, destinationPlugin.Name, destinationPlugin.Origin, containerFormKey);
            }
            return minted;
        }

        var containerUnit = SourceUnitResolver.Resolve(
            reads, destinationPlugin, destinationModFolder, containerFormKey, destinationContainer.RecordType,
            destinationContainer.EditorId, release)
            ?? throw new InvalidOperationException(
                $"{containerFormKey} is indexed in {destinationPlugin.Name} but SourceUnitResolver cannot find its source unit.");

        var containerRecord = RecordEditService.ReadRecordFromSource(codec, logger, containerUnit.FullPath, destinationContainer, release);
        ContainerChildFields.AddChildToSlot(containerRecord, embedding.SlotName, childRecord);
        var newContainerBody = RecordEditService.SerializeAndWrite(codec, containerRecord, containerUnit.FullPath, release);

        try
        {
            index.ApplyWorkingTreeChanges(destinationPlugin, [(containerFormKey, newContainerBody)]);
        }
        catch (Exception ex)
        {
            // The container's file already carries the child's bytes, so a failure here must not
            // surface as a bare exception that says nothing about the file that landed.
            logger.LogError(
                ex, "Index update failed after writing {ContainerFormKey}'s new body to {SourcePath} for copied child {FormKey}",
                containerFormKey, containerUnit.FullPath, formKey);
            return RecordEditResult.Refused(
                RecordEditRefusal.ContainerCopyIndexUpdateFailedAfterWrite,
                $"{containerFormKey}'s working-tree file was updated to carry {formKey}, but the index failed to " +
                $"record it ({ex.Message}). The file itself is a real, reviewable working-tree change — check " +
                "the Source Control panel, or relaunch mEdit to re-index it.");
        }
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — appended into {ContainerFormKey}'s {SlotName} slot",
                formKey, sourcePlugin.Name, sourcePlugin.Origin, destinationPlugin.Name, destinationPlugin.Origin,
                containerFormKey, embedding.SlotName);
        }
        return RecordEditResult.Success();
    }

    // ReplaceInSlot keeps the child at its exact slot position; append-after-remove would silently
    // reorder the GRUP. The destination's container is the right one even when the source has since
    // moved the child elsewhere.
    private RecordEditResult ReplaceEmbeddedChildInPlace(
        PluginKey sourcePlugin, string formKey, RecordDocument document,
        PluginKey destinationPlugin, string destinationModFolder, IRecordIndex index, GameRelease release)
    {
        var reads = index.At(RecordRef.Effective);
        var embedding = EmbeddedContainerOf(reads, destinationPlugin, formKey, release)
            ?? throw new InvalidOperationException(
                $"{destinationPlugin.Name} holds {formKey} but no container document of its own carries it.");
        var container = embedding.Container;
        var containerUnit = SourceUnitResolver.Resolve(
                reads, destinationPlugin, destinationModFolder, container.FormKey, container.RecordType,
                container.EditorId, release)
            ?? throw new InvalidOperationException(
                $"{container.FormKey} is indexed in {destinationPlugin.Name} but SourceUnitResolver cannot find its source unit.");

        var containerRecord = RecordEditService.ReadRecordFromSource(codec, logger, containerUnit.FullPath, container, release);
        var found = ContainerChildFields.FindEmbeddedChild(containerRecord, formKey)
            ?? throw new InvalidOperationException(
                $"{containerUnit.RelativePath} is indexed as holding {formKey}, but its own text does not carry it.");
        var replacement = codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body!), release, document.RecordType)
            .GetAwaiter().GetResult();
        ContainerChildFields.ReplaceInSlot(containerRecord, found.SlotName, found.SlotIndex, replacement);

        var newContainerBody = RecordEditService.SerializeAndWrite(codec, containerRecord, containerUnit.FullPath, release);
        index.ApplyWorkingTreeChanges(destinationPlugin, [(container.FormKey, newContainerBody)]);
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — replaced the existing embedded copy in {ContainerFormKey} at its own slot",
                formKey, sourcePlugin.Name, sourcePlugin.Origin, destinationPlugin.Name, destinationPlugin.Origin, container.FormKey);
        }
        return RecordEditResult.Success();
    }

    // A block-placed exterior cell lands through the spatial mint with its worldspace; everything
    // else in its own directory or under its own parent's slot.
    private RecordEditResult PlaceMintedContainer(
        PluginKey sourcePlugin, string formKey, string recordType, IMajorRecord record,
        PluginKey destinationPlugin, string destinationModFolder, IRecordIndex index, GameRelease release)
    {
        var reads = index.At(RecordRef.Effective);
        if (reads.GetCellLocation(sourcePlugin, formKey) is { IsInterior: false } exterior)
        {
            // Only a genuine SubCells cell has a block to mint at; a worldspace's own persistent cell
            // carries none.
            if (exterior.BlockX == null)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.ContainerParentMissingInDestination,
                    $"{destinationPlugin.Name} has no override of {formKey}, the container the copied record belongs to. " +
                    $"{formKey} is an exterior cell with no worldspace grid position of its own — a worldspace's " +
                    "persistent cell, not one of its numbered blocks — so mEdit cannot auto-create an override of it here.");
            }
            return MintExteriorCell(sourcePlugin, formKey, exterior, record, destinationPlugin, destinationModFolder, index, release);
        }

        EnsureContainerAncestorDirectory(
            index, reads, sourcePlugin, formKey, recordType, destinationPlugin, destinationModFolder, release, leaf: record);
        mirror.ReapplyFilter();
        return RecordEditResult.Success();
    }

    /// <summary>Mints an exterior CELL at its worldspace block/sub-block, auto-creating a bare Partial
    /// Form WRLD when the destination has none. Index rows are written from the exact bytes the mint
    /// wrote, never a second serialization.</summary>
    internal RecordEditResult MintExteriorCell(
        PluginKey sourcePlugin, string cellFormKey, CellLocationRow cellLocation, IMajorRecord cellRecord,
        PluginKey destinationPlugin, string destinationModFolder, IRecordIndex index, GameRelease release)
    {
        if (!RecordEditService.IsFreeAtBothRefs(index, destinationPlugin, cellFormKey))
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

        // An existing worldspace override is merged into, resolved by scanning the tree: its directory
        // name carries the destination's EditorID, which the bare synthetic ancestor's never would.
        var reads = index.At(RecordRef.Effective);
        var existingWorldspace = reads.GetDocument(worldspaceFormKey, destinationPlugin);
        string? existingWorldspaceDirectory = null;
        if (existingWorldspace != null)
        {
            var worldspaceUnit = SourceUnitResolver.Resolve(
                reads, destinationPlugin, destinationModFolder, worldspaceFormKey,
                existingWorldspace.RecordType, existingWorldspace.EditorId, release)
                ?? throw new InvalidOperationException(
                    $"{worldspaceFormKey} is indexed in {destinationPlugin.Name} but SourceUnitResolver cannot find its source unit.");
            existingWorldspaceDirectory = Path.GetDirectoryName(worldspaceUnit.FullPath)!;
        }

        var sourceWorldspaceDocument = reads.GetDocument(worldspaceFormKey, sourcePlugin)
            ?? throw new InvalidOperationException(
                $"{sourcePlugin.Name} does not hold {worldspaceFormKey} — cell_location resolved this FormKey from its own row.");

        var worldspaceAncestor = BarePartialFormAncestor(worldspaceFormKey, sourceWorldspaceDocument.RecordType, release);

        var syntheticMod = SpatialContainerMint.BuildSyntheticWorldspaceMod(
            destinationPlugin, worldspaceAncestor, cellLocation, cellRecord, release);
        var minted = SpatialContainerMint.MintAsync(
                syntheticMod, destinationModFolder, destinationPlugin.Name, existingWorldspaceDirectory)
            .GetAwaiter().GetResult();

        if (existingWorldspace == null)
        {
            index.CreateWorkingTreeRecord(
                destinationPlugin, worldspaceFormKey, sourceWorldspaceDocument.RecordType,
                Encoding.UTF8.GetString(minted.WorldspaceBody));
        }
        // The cell's block and sub-block are the directories the mint wrote, a fact no document
        // carries, so the row is copied from the source's rather than derived.
        index.CreateCellLocation(destinationPlugin, cellLocation);
        index.CreateWorkingTreeRecord(
            destinationPlugin, cellFormKey, SourceRecordType.Resolve(cellRecord, schemaReflector.GetSchemas(release)),
            Encoding.UTF8.GetString(minted.CellBody));

        // Both callers rely on this leaving the index consistent, so the filter is reapplied here.
        mirror.ReapplyFilter();

        return RecordEditResult.Success();
    }

    /// <summary>The destination's override of the ancestor, found or minted as <paramref name="leaf"/>
    /// (else bare and Partial Form), recursing for a folder-split ancestor's own parent.</summary>
    internal string EnsureContainerAncestorDirectory(
        IRecordIndex index, IRecordReads reads, PluginKey sourcePlugin, string ancestorFormKey,
        string ancestorRecordType, PluginKey destinationPlugin, string destinationModFolder, GameRelease release,
        IMajorRecord? leaf = null)
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

        var record = leaf ?? BarePartialFormAncestor(ancestorFormKey, ancestorRecordType, release);

        SourcePlacement placement;
        ContainerChildRow? ownParent = null;
        if (RecordTypeDispatch.For(release).GroupFolderNameFor(ancestorRecordType) is not null)
        {
            // A top-level container: its own directory in the group folder, listed by the group. An
            // interior cell's block bucket is chosen (or minted) rather than derived.
            var blockPath = reads.GetCellLocation(sourcePlugin, ancestorFormKey)?.IsInterior == true
                ? RecordEditService.EnsureInteriorCellBlockPath(destinationModFolder, destinationPlugin.Name, release)
                : null;
            placement = SourcePlacement.For(
                destinationPlugin.Name, ancestorRecordType, ancestorFormKey, record.EditorID, release, blockPath);
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
                destinationModFolder, parentDirectory, ownParent.Value.SlotName, ancestorFormKey, record.EditorID, isDirectory: true);
        }

        var recordDataPath = Path.Combine(destinationModFolder, placement.RelativePath);
        var body = RecordEditService.WritePlaced(
            destinationModFolder, placement, ancestorFormKey, path => RecordEditService.SerializeAndWrite(codec, record, path, release));
        index.CreateWorkingTreeRecord(destinationPlugin, ancestorFormKey, ancestorRecordType, body);
        if (ownParent is { } parentSlot)
        {
            AppendChildToSlot(
                index, reads, destinationPlugin, parentSlot.ParentFormKey, parentSlot.ParentRecordType,
                parentSlot.SlotName, ancestorFormKey);
        }

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Auto-created {FormKey} as a Partial Form override in {DestinationPlugin} ({DestinationOrigin}) " +
                "— parent chain for a copied child",
                ancestorFormKey, destinationPlugin.Name, destinationPlugin.Origin);
        }
        return Path.GetDirectoryName(recordDataPath)!;
    }

    /// <summary>A folder-split child's membership in its parent's slot, appended at the end: it is in
    /// no document the index could derive this from.</summary>
    internal static void AppendChildToSlot(
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

    // Bare fields, no EditorID is xEdit parity (AddIfMissingInternal's Assign() runs only under
    // `if aDeepCopy`, hardcoded False for ancestors).
    private IMajorRecord BarePartialFormAncestor(string formKey, string recordType, GameRelease release) =>
        RecordEditService.BareRecord(codec, schemaReflector.GetSchemas(release)[recordType], release, formKey, editorId: null, partialForm: true);
}
