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
    /// Null for a record no container's document carries.</summary>
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

    /// <summary>Bare fields are xEdit parity; Partial Form is a deliberate mEdit divergence, so conflict
    /// detection ignores the ancestor's stub fields. Own fields only, like every plain Copy as Override:
    /// a copied topic lands with no responses.</summary>
    internal RecordEditResult CopyEmbeddedChildAsOverride(
        PluginKey sourcePlugin, string formKey, RecordDocument document, Embedding embedding,
        PluginKey destinationPlugin, string destinationModFolder, IRecordIndex index, GameRelease release)
    {
        var childRecord = codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(document.Body!), release, document.RecordType)
            .GetAwaiter().GetResult();
        ContainerChildFields.ClearAllChildSlots(childRecord);

        if (!RecordEditService.IsFreeAtBothRefs(index, destinationPlugin, formKey))
        {
            // The explicitly-selected child already held at Effective is replaced in place, never
            // duplicated or refused. Held only at Head (deleted in the working tree) still refuses.
            if (index.At(RecordRef.Effective).GetDocument(formKey, destinationPlugin) != null)
            {
                return ReplaceEmbeddedChildInPlace(
                    sourcePlugin, formKey, childRecord, destinationPlugin, destinationModFolder, index, release);
            }
            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{formKey} is already held by a record in {destinationPlugin.Name} at some ref.");
        }

        var appended = AppendEmbeddedChild(
            sourcePlugin, embedding.Container.FormKey, embedding.Container.RecordType, embedding.SlotName, childRecord,
            destinationPlugin, destinationModFolder, index, release);

        if (appended.Applied && logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — inside {ContainerFormKey}'s {SlotName} slot",
                formKey, sourcePlugin.Name, sourcePlugin.Origin, destinationPlugin.Name, destinationPlugin.Origin,
                embedding.Container.FormKey, embedding.SlotName);
        }
        return appended;
    }

    /// <summary>The container rule: the child lands at the end of its slot in the destination's copy
    /// of the container's document, minted bare and Partial Form when absent, transitively; the index
    /// derives its rows from that document.</summary>
    internal RecordEditResult AppendEmbeddedChild(
        PluginKey sourcePlugin, string containerFormKey, string containerRecordType, string slotName, IMajorRecord childRecord,
        PluginKey destinationPlugin, string destinationModFolder, IRecordIndex index, GameRelease release)
    {
        var reads = index.At(RecordRef.Effective);
        var childFormKey = childRecord.FormKey.ToString();

        var destinationContainer = reads.GetDocument(containerFormKey, destinationPlugin);
        if (destinationContainer == null)
        {
            var bare = BarePartialFormAncestor(containerFormKey, containerRecordType, release);
            ContainerChildFields.AddChildToSlot(bare, slotName, childRecord);
            // A container that is itself a child lands in its own container's slot by the same rule,
            // and a top-level one at a placement of its own.
            var minted = reads.GetContainerParent(sourcePlugin, containerFormKey) is { } ownParent
                ? AppendEmbeddedChild(
                    sourcePlugin, ownParent.ParentFormKey, ownParent.ParentRecordType, ownParent.SlotName, bare,
                    destinationPlugin, destinationModFolder, index, release)
                : PlaceMintedContainer(
                    sourcePlugin, containerFormKey, containerRecordType, bare, destinationPlugin, destinationModFolder, index, release);
            if (minted.Applied && logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation(
                    "Landed {FormKey} in {DestinationPlugin} ({DestinationOrigin}) — minted its container {ContainerFormKey} " +
                    "as a Partial Form ancestor around it",
                    childFormKey, destinationPlugin.Name, destinationPlugin.Origin, containerFormKey);
            }
            return minted;
        }

        // The container may itself be embedded (a topic inside its quest's document): the file read
        // and written is the document's root, and the container is found inside it.
        var containerUnit = SourceUnitResolver.Resolve(
            reads, destinationPlugin, destinationModFolder, containerFormKey, destinationContainer.RecordType,
            destinationContainer.EditorId, release)
            ?? throw new InvalidOperationException(
                $"{containerFormKey} is indexed in {destinationPlugin.Name} but SourceUnitResolver cannot find its source unit.");
        var owner = reads.GetDocument(containerUnit.OwnerFormKey, destinationPlugin)!;
        var ownerRecord = RecordEditService.ReadRecordFromSource(codec, logger, containerUnit.FullPath, owner, release);
        var containerRecord = containerUnit.IsEmbedded
            ? ContainerChildFields.FindEmbeddedChild(ownerRecord, containerFormKey)?.Child
              ?? throw new InvalidOperationException(
                  $"{containerUnit.RelativePath} is indexed as holding {containerFormKey}, but its own text does not carry it.")
            : ownerRecord;
        ContainerChildFields.AddChildToSlot(containerRecord, slotName, childRecord);
        RecordEditService.SerializeAndWrite(codec, ownerRecord, containerUnit.FullPath, release);
        mirror.ReapplyFilter();
        return RecordEditResult.Success();
    }

    // ReplaceInSlot keeps the child at its exact slot position; append-after-remove would silently
    // reorder the GRUP. The destination's own children of the replaced record are transplanted onto
    // the replacement, so an own-fields copy can never delete them.
    private RecordEditResult ReplaceEmbeddedChildInPlace(
        PluginKey sourcePlugin, string formKey, IMajorRecord replacement,
        PluginKey destinationPlugin, string destinationModFolder, IRecordIndex index, GameRelease release)
    {
        var reads = index.At(RecordRef.Effective);
        var existing = reads.GetDocument(formKey, destinationPlugin)!;
        var unit = SourceUnitResolver.Resolve(
                reads, destinationPlugin, destinationModFolder, formKey, existing.RecordType, existing.EditorId, release)
            ?? throw new InvalidOperationException(
                $"{formKey} is indexed in {destinationPlugin.Name} but SourceUnitResolver cannot find its source unit.");
        if (!unit.IsEmbedded)
        {
            throw new InvalidOperationException(
                $"{destinationPlugin.Name} holds {formKey} but no container document of its own carries it.");
        }

        var owner = reads.GetDocument(unit.OwnerFormKey, destinationPlugin)!;
        var ownerRecord = RecordEditService.ReadRecordFromSource(codec, logger, unit.FullPath, owner, release);
        var found = ContainerChildFields.FindEmbeddedChild(ownerRecord, formKey)
            ?? throw new InvalidOperationException(
                $"{unit.RelativePath} is indexed as holding {formKey}, but its own text does not carry it.");
        ContainerChildFields.TransplantChildSlots(found.Child, replacement);
        ContainerChildFields.ReplaceInSlot(found.Parent, found.SlotName, found.SlotIndex, replacement);

        RecordEditService.SerializeAndWrite(codec, ownerRecord, unit.FullPath, release);
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — replaced the existing embedded copy in {ContainerFormKey} at its own slot",
                formKey, sourcePlugin.Name, sourcePlugin.Origin, destinationPlugin.Name, destinationPlugin.Origin, unit.OwnerFormKey);
        }
        return RecordEditResult.Success();
    }

    // A top-level container the destination lacks: a block-placed exterior cell lands through the
    // spatial mint with its worldspace; everything else at its own placement in its group folder.
    private RecordEditResult PlaceMintedContainer(
        PluginKey sourcePlugin, string formKey, string recordType, IMajorRecord record,
        PluginKey destinationPlugin, string destinationModFolder, IRecordIndex index, GameRelease release)
    {
        var reads = index.At(RecordRef.Effective);
        var cellLocation = reads.GetCellLocation(sourcePlugin, formKey);
        if (cellLocation is { IsInterior: false } exterior)
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

        // An interior cell's block bucket is chosen (or minted) rather than derived.
        var placement = SourcePlacement.For(
            destinationPlugin.Name, recordType, formKey, record.EditorID, release,
            cellLocation != null ? RecordEditService.EnsureInteriorCellBlockPath(destinationModFolder, destinationPlugin.Name, release) : null);
        RecordEditService.WriteAt(
            destinationModFolder, placement, path => RecordEditService.SerializeAndWrite(codec, record, path, release));
        mirror.ReapplyFilter();

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Auto-created {FormKey} as a Partial Form override in {DestinationPlugin} ({DestinationOrigin}) " +
                "— container for a copied child, at {SourcePath}",
                formKey, destinationPlugin.Name, destinationPlugin.Origin, placement.RelativePath);
        }
        return RecordEditResult.Success();
    }

    /// <summary>Mints an exterior CELL at its worldspace block/sub-block, auto-creating a bare Partial
    /// Form WRLD when the destination has none. The block directories it writes are where the cell's
    /// location is read back from.</summary>
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
        SpatialContainerMint.MintAsync(
                syntheticMod, destinationModFolder, destinationPlugin.Name, existingWorldspaceDirectory)
            .GetAwaiter().GetResult();

        // The cell's block and sub-block are the directories the mint wrote, a fact no document
        // carries: the projector re-derives them from the tree the mint just changed.
        mirror.ReapplyFilter();

        return RecordEditResult.Success();
    }

    // Bare fields, no EditorID is xEdit parity (AddIfMissingInternal's Assign() runs only under
    // `if aDeepCopy`, hardcoded False for ancestors).
    private IMajorRecord BarePartialFormAncestor(string formKey, string recordType, GameRelease release) =>
        RecordEditService.BareRecord(codec, schemaReflector.GetSchemas(release)[recordType], release, formKey, editorId: null, partialForm: true);
}
