using MEditService.Core.Plugins;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Core.Edits;

/// <summary>The container half of both copy gestures: a child lands inside its container's document,
/// minted bare and Partial Form when the destination lacks it. Shares the write side's schema and
/// codec: one write path (ADR-0007).</summary>
internal sealed class RecordCopy(SchemaReflector schemaReflector, ILogger logger, RecordTextCodec codec)
{
    /// <summary>The tracked plugin a copy lands in: its repository, its key, and the mod folder the
    /// spatial mint writes directories under.</summary>
    internal readonly record struct Destination(SourceRepository Repository, PluginKey Plugin, string ModFolder);

    /// <summary>Bare fields are xEdit parity; Partial Form is a deliberate mEdit divergence, so conflict
    /// detection ignores the ancestor's stub fields. Own fields only, like every plain Copy as Override:
    /// a copied topic lands with no responses.</summary>
    internal RecordEditResult CopyEmbeddedChildAsOverride(
        CopySource source, SourceDocument child, DocumentContainment container,
        Destination destination, GameRelease release)
    {
        var formKey = child.FormKey;
        var ownFields = child with { Body = ContainerDocumentEdits.WithoutChildren(codec, child.Body, release, child.RecordType) };

        if (destination.Repository.HoldsAtEitherRef(destination.Plugin, formKey))
        {
            // The explicitly-selected child already in the working tree is replaced in place, never
            // duplicated or refused. Held only at Head (deleted in the working tree) still refuses.
            if (Identity(destination, formKey, release) is { } existing)
                return ReplaceEmbeddedChildInPlace(source.Plugin, existing, ownFields, destination, release);

            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{formKey} is already held by a record in {destination.Plugin.Name} at some ref.");
        }

        var appended = AppendEmbeddedChild(source, container, ownFields, destination, release);

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
        CopySource source, DocumentContainment container, SourceDocument child,
        Destination destination, GameRelease release)
    {
        var containerFormKey = container.ParentFormKey;
        if (Identity(destination, containerFormKey, release) is not { } destinationContainer)
            return MintContainerAround(source, container, child, destination, release);

        // The container may itself be embedded (a topic inside its quest's document): the file read
        // and written is the document's root, and the container is found inside it.
        var containerUnit = Locate(destination, destinationContainer);
        var ownerText = File.ReadAllText(containerUnit.FullPath);
        var withChild = ContainerDocumentEdits.WithChildAppended(
                codec, ownerText, release, containerUnit.OwnerRecordType, containerFormKey, container.SlotName,
                child.Body, child.RecordType)
            ?? throw new InvalidOperationException(
                $"{containerUnit.RelativePath} was found holding {containerFormKey}, but its own text does not carry it.");

        SourceRepository.WriteTextAtomic(containerUnit.FullPath, withChild);
        return RecordEditResult.Success();
    }

    // A container the destination lacks is minted bare and Partial Form around the child: itself a
    // child lands in its own container's slot by the same rule, a top-level one at a placement.
    private RecordEditResult MintContainerAround(
        CopySource source, DocumentContainment container, SourceDocument child,
        Destination destination, GameRelease release)
    {
        var containerFormKey = container.ParentFormKey;
        var bare = BarePartialFormAncestor(containerFormKey, container.ParentRecordType, release);
        var bareWithChild = bare with
        {
            Body = ContainerDocumentEdits.WithChildAppended(
                       codec, bare.Body, release, bare.RecordType, containerFormKey, container.SlotName,
                       child.Body, child.RecordType)
                   ?? throw new InvalidOperationException(
                       $"The bare {container.ParentRecordType} minted for {containerFormKey} does not carry its own FormKey."),
        };

        var sourceContainer = source.Identity(containerFormKey);
        var minted = sourceContainer is { } held && source.ContainerOf(held) is { } ownParent
            ? AppendEmbeddedChild(source, ownParent, bareWithChild, destination, release)
            : PlaceMintedContainer(source, bareWithChild, destination, release);

        if (minted.Applied && logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Landed {FormKey} in {DestinationPlugin} ({DestinationOrigin}) — minted its container {ContainerFormKey} " +
                "as a Partial Form ancestor around it",
                child.FormKey, destination.Plugin.Name, destination.Plugin.Origin, containerFormKey);
        }
        return minted;
    }

    // ReplaceInSlot keeps the child at its exact slot position; append-after-remove would silently
    // reorder the GRUP. The destination's own children of the replaced record are transplanted onto
    // the replacement, so an own-fields copy can never delete them.
    private RecordEditResult ReplaceEmbeddedChildInPlace(
        PluginKey sourcePlugin, RecordIdentity existing, SourceDocument replacement,
        Destination destination, GameRelease release)
    {
        var unit = Locate(destination, existing);
        if (!unit.IsEmbedded)
        {
            throw new InvalidOperationException(
                $"{destination.Plugin.Name} holds {existing.FormKey} but no container document of its own carries it.");
        }

        var replaced = ContainerDocumentEdits.WithChildReplaced(
                codec, File.ReadAllText(unit.FullPath), release, unit.OwnerRecordType, existing.FormKey,
                replacement.Body, replacement.RecordType)
            ?? throw new InvalidOperationException(
                $"{unit.RelativePath} was found holding {existing.FormKey}, but its own text does not carry it.");

        SourceRepository.WriteTextAtomic(unit.FullPath, replaced);

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
        CopySource source, SourceDocument container, Destination destination, GameRelease release)
    {
        var formKey = container.FormKey;
        var placement = RecordTypeDispatch.For(release).IsCell(container.RecordType)
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
            return MintExteriorCell(source, exterior, container, destination, release);
        }

        // An interior cell's block bucket is chosen (or minted) rather than derived.
        var written = SourceRepository.PlacementFor(
            destination.Plugin.Name, container.RecordType, formKey, container.EditorId, release,
            placement != null
                ? SourceRepository.EnsureInteriorCellBlockPath(destination.ModFolder, destination.Plugin.Name, release)
                : null);
        SourceRepository.WriteAt(
            destination.ModFolder, written, path =>
            {
                SourceRepository.WriteTextAtomic(path, container.Body);
                return container.Body;
            });

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
        CopySource source, CellPlacement placement, SourceDocument cell, Destination destination, GameRelease release)
    {
        var cellFormKey = cell.FormKey;
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

        SpatialContainerMint.Mint(
            codec, destination, release, placement, worldspaceAncestor,
            cell with { RecordType = sourceCell.RecordType }, source.Body(sourceCell), existingWorldspaceDirectory);

        return RecordEditResult.Success();
    }

    /// <summary>What the destination's tree names at <paramref name="formKey"/>, or null when nothing
    /// in it carries that key at the working tree.</summary>
    internal RecordIdentity? Identity(Destination destination, string formKey, GameRelease release) =>
        destination.Repository.IdentityOf(destination.Plugin, formKey, schemaReflector.GetSchemas(release));

    // The destination is tracked by the time any copy writes to it, so a record its own tree names is
    // in that tree.
    private static SourceUnit Locate(Destination destination, RecordIdentity identity) =>
        destination.Repository.Locate(destination.Plugin, identity)
        ?? throw new InvalidOperationException(
            $"{destination.Plugin.Name} holds {identity.FormKey}, but no document in its source tree carries it.");

    // Bare fields, no EditorID is xEdit parity (AddIfMissingInternal's Assign() runs only under
    // `if aDeepCopy`, hardcoded False for ancestors).
    private SourceDocument BarePartialFormAncestor(string formKey, string recordType, GameRelease release) =>
        new(formKey, recordType, null,
            RecordMint.BareDocument(
                codec, schemaReflector.GetSchemas(release)[recordType], release, formKey, editorId: null, partialForm: true));
}
