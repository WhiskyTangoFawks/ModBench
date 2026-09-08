using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

/// <summary>The container half of both copy gestures: a child lands inside its container's document,
/// minted bare and Partial Form when the destination lacks it. Shares the write side's schema and
/// codec: one write path (ADR-0041).</summary>
internal sealed class RecordCopy(SchemaReflector schemaReflector, ILogger logger, RecordTextCodec codec)
{
    /// <summary>The tracked plugin a copy lands in: its repository, its key, and the mod folder the
    /// spatial mint writes directories under.</summary>
    internal readonly record struct Destination(SourceRepository Repository, PluginKey Plugin, string ModFolder);

    /// <summary>Bare fields are xEdit parity; Partial Form is a deliberate mEdit divergence, so conflict
    /// detection ignores the ancestor's stub fields. Own fields only, like every plain Copy as Override:
    /// a copied topic lands with no responses.</summary>
    internal RecordEditResult CopyEmbeddedChildAsOverride(
        CopySource source, string formKey, IMajorRecord childRecord, CopySource.Containment container,
        Destination destination, GameRelease release)
    {
        ContainerChildFields.ClearAllChildSlots(childRecord);

        if (destination.Repository.HoldsAtEitherRef(destination.Plugin, formKey))
        {
            // The explicitly-selected child already in the working tree is replaced in place, never
            // duplicated or refused. Held only at Head (deleted in the working tree) still refuses.
            if (Identity(destination, formKey, release) is { } existing)
                return ReplaceEmbeddedChildInPlace(source.Plugin, existing, childRecord, destination, release);

            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{formKey} is already held by a record in {destination.Plugin.Name} at some ref.");
        }

        var appended = AppendEmbeddedChild(
            source, container.ParentFormKey, container.ParentRecordType, container.SlotName, childRecord,
            destination, release);

        if (appended.Applied && logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — inside {ContainerFormKey}'s {SlotName} slot",
                formKey, source.Plugin.Name, source.Plugin.Origin, destination.Plugin.Name, destination.Plugin.Origin,
                container.ParentFormKey, container.SlotName);
        }
        return appended;
    }

    /// <summary>The container rule: the child lands at the end of its slot in the destination's copy
    /// of the container's document, minted bare and Partial Form when absent, transitively; the index
    /// derives its rows from that document.</summary>
    internal RecordEditResult AppendEmbeddedChild(
        CopySource source, string containerFormKey, string containerRecordType, string slotName,
        IMajorRecord childRecord, Destination destination, GameRelease release)
    {
        var childFormKey = childRecord.FormKey.ToString();

        if (Identity(destination, containerFormKey, release) is not { } destinationContainer)
        {
            var bare = BarePartialFormAncestor(containerFormKey, containerRecordType, release);
            ContainerChildFields.AddChildToSlot(bare, slotName, childRecord);
            // A container that is itself a child lands in its own container's slot by the same rule,
            // and a top-level one at a placement of its own.
            var sourceContainer = source.Identity(containerFormKey);
            var minted = sourceContainer is { } held && source.ContainerOf(held) is { } ownParent
                ? AppendEmbeddedChild(
                    source, ownParent.ParentFormKey, ownParent.ParentRecordType, ownParent.SlotName, bare,
                    destination, release)
                : PlaceMintedContainer(
                    source, containerFormKey, containerRecordType, bare, destination, release);
            if (minted.Applied && logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation(
                    "Landed {FormKey} in {DestinationPlugin} ({DestinationOrigin}) — minted its container {ContainerFormKey} " +
                    "as a Partial Form ancestor around it",
                    childFormKey, destination.Plugin.Name, destination.Plugin.Origin, containerFormKey);
            }
            return minted;
        }

        // The container may itself be embedded (a topic inside its quest's document): the file read
        // and written is the document's root, and the container is found inside it.
        var containerUnit = Locate(destination, destinationContainer);
        var ownerRecord = ReadOwner(containerUnit, release);
        var containerRecord = containerUnit.IsEmbedded
            ? ContainerChildFields.FindEmbeddedChild(ownerRecord, containerFormKey)?.Child
              ?? throw new InvalidOperationException(
                  $"{containerUnit.RelativePath} was found holding {containerFormKey}, but its own text does not carry it.")
            : ownerRecord;
        ContainerChildFields.AddChildToSlot(containerRecord, slotName, childRecord);
        RecordEditService.SerializeAndWrite(codec, ownerRecord, containerUnit.FullPath, release);
        return RecordEditResult.Success();
    }

    // ReplaceInSlot keeps the child at its exact slot position; append-after-remove would silently
    // reorder the GRUP. The destination's own children of the replaced record are transplanted onto
    // the replacement, so an own-fields copy can never delete them.
    private RecordEditResult ReplaceEmbeddedChildInPlace(
        PluginKey sourcePlugin, RecordIdentity existing, IMajorRecord replacement,
        Destination destination, GameRelease release)
    {
        var unit = Locate(destination, existing);
        if (!unit.IsEmbedded)
        {
            throw new InvalidOperationException(
                $"{destination.Plugin.Name} holds {existing.FormKey} but no container document of its own carries it.");
        }

        var ownerRecord = ReadOwner(unit, release);
        var found = ContainerChildFields.FindEmbeddedChild(ownerRecord, existing.FormKey)
            ?? throw new InvalidOperationException(
                $"{unit.RelativePath} was found holding {existing.FormKey}, but its own text does not carry it.");
        ContainerChildFields.TransplantChildSlots(found.Child, replacement);
        ContainerChildFields.ReplaceInSlot(found.Parent, found.SlotName, found.SlotIndex, replacement);

        RecordEditService.SerializeAndWrite(codec, ownerRecord, unit.FullPath, release);

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — replaced the existing embedded copy in {ContainerFormKey} at its own slot",
                existing.FormKey, sourcePlugin.Name, sourcePlugin.Origin, destination.Plugin.Name,
                destination.Plugin.Origin, unit.OwnerFormKey);
        }
        return RecordEditResult.Success();
    }

    // A top-level container the destination lacks: a block-placed exterior cell lands through the
    // spatial mint with its worldspace; everything else at its own placement in its group folder.
    private RecordEditResult PlaceMintedContainer(
        CopySource source, string formKey, string recordType, IMajorRecord record,
        Destination destination, GameRelease release)
    {
        var placement = RecordEditService.IsCellType(recordType, release)
            && source.Identity(formKey) is { } identity
                ? source.CellPlacementOf(identity)
                : null;
        if (placement is { IsInterior: false } exterior)
        {
            // Only a genuine SubCells cell has a block to mint at; a worldspace's own persistent cell
            // carries none.
            if (exterior.BlockX == null)
            {
                return RecordEditResult.Refused(
                    RecordEditRefusal.ContainerParentMissingInDestination,
                    $"{destination.Plugin.Name} has no override of {formKey}, the container the copied record belongs to. " +
                    $"{formKey} is an exterior cell with no worldspace grid position of its own — a worldspace's " +
                    "persistent cell, not one of its numbered blocks — so mEdit cannot auto-create an override of it here.");
            }
            return MintExteriorCell(source, formKey, exterior, record, destination, release);
        }

        // An interior cell's block bucket is chosen (or minted) rather than derived.
        var written = SourceRepository.PlacementFor(
            destination.Plugin.Name, recordType, formKey, record.EditorID, release,
            placement != null
                ? RecordEditService.EnsureInteriorCellBlockPath(destination.ModFolder, destination.Plugin.Name, release)
                : null);
        RecordEditService.WriteAt(
            destination.ModFolder, written, path => RecordEditService.SerializeAndWrite(codec, record, path, release));

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Auto-created {FormKey} as a Partial Form override in {DestinationPlugin} ({DestinationOrigin}) " +
                "— container for a copied child, at {SourcePath}",
                formKey, destination.Plugin.Name, destination.Plugin.Origin, written.RelativePath);
        }
        return RecordEditResult.Success();
    }

    /// <summary>Mints an exterior CELL at its worldspace block/sub-block, auto-creating a bare Partial
    /// Form WRLD when the destination has none. The block directories it writes are where the cell's
    /// location is read back from.</summary>
    internal RecordEditResult MintExteriorCell(
        CopySource source, string cellFormKey, CellPlacement placement, IMajorRecord cellRecord,
        Destination destination, GameRelease release)
    {
        if (destination.Repository.HoldsAtEitherRef(destination.Plugin, cellFormKey))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{cellFormKey} is already held by a record in {destination.Plugin.Name} at some ref.");
        }

        if (placement.ParentWorldspace is not { } worldspaceFormKey)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.ContainerParentMissingInDestination,
                $"{cellFormKey} has no recorded parent worldspace — cannot place it.");
        }

        // An existing worldspace override is merged into: its directory name carries the destination's
        // EditorID, which the bare synthetic ancestor's never would.
        string? existingWorldspaceDirectory = null;
        if (Identity(destination, worldspaceFormKey, release) is { } existingWorldspace)
            existingWorldspaceDirectory = Path.GetDirectoryName(Locate(destination, existingWorldspace).FullPath)!;

        var sourceWorldspace = source.Identity(worldspaceFormKey)
            ?? throw new InvalidOperationException(
                $"{source.Plugin.Name} does not hold {worldspaceFormKey} — the cell it carries names it as its worldspace.");
        var worldspaceAncestor = BarePartialFormAncestor(worldspaceFormKey, sourceWorldspace.RecordType, release);

        // The mint's cell (bare when it is only a placed reference's ancestor) carries none of its own
        // grid; the source cell's document does, so the grid rides along from here.
        var sourceCell = source.Identity(cellFormKey)
            ?? throw new InvalidOperationException(
                $"{source.Plugin.Name} does not hold {cellFormKey} — its own placement named it.");

        var syntheticMod = SpatialContainerMint.BuildSyntheticWorldspaceMod(
            destination.Plugin, worldspaceAncestor, placement, cellRecord, source.Record(sourceCell), release);
        SpatialContainerMint.MintAsync(
                syntheticMod, destination.ModFolder, destination.Plugin.Name, existingWorldspaceDirectory)
            .GetAwaiter().GetResult();

        return RecordEditResult.Success();
    }

    /// <summary>What the destination's tree names at <paramref name="formKey"/>, or null when nothing
    /// in it carries that key at the working tree.</summary>
    internal RecordIdentity? Identity(Destination destination, string formKey, GameRelease release) =>
        destination.Repository.IdentityOf(destination.Plugin, formKey, schemaReflector.GetSchemas(release));

    private IMajorRecord ReadOwner(SourceUnit unit, GameRelease release) =>
        codec.DeserializeAsync(unit.FullPath, release, unit.OwnerRecordType).GetAwaiter().GetResult();

    // The destination is tracked by the time any copy writes to it, so a record its own tree names is
    // in that tree.
    private static SourceUnit Locate(Destination destination, RecordIdentity identity) =>
        destination.Repository.Locate(destination.Plugin, identity)
        ?? throw new InvalidOperationException(
            $"{destination.Plugin.Name} holds {identity.FormKey}, but no document in its source tree carries it.");

    // Bare fields, no EditorID is xEdit parity (AddIfMissingInternal's Assign() runs only under
    // `if aDeepCopy`, hardcoded False for ancestors).
    private IMajorRecord BarePartialFormAncestor(string formKey, string recordType, GameRelease release) =>
        RecordEditService.BareRecord(codec, schemaReflector.GetSchemas(release)[recordType], release, formKey, editorId: null, partialForm: true);
}
