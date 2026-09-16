using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>The container half of both copy gestures: a child lands inside its container's document,
/// minted bare and Partial Form when the destination lacks it. Shares the write side's schema and
/// codec: one write path (ADR-0007).</summary>
internal sealed class RecordCopy(SchemaReflector schemaReflector, ILogger logger, RecordTextCodec codec)
{
    /// <summary>The tracked plugin a copy lands in: its repository and its key. No folder — every
    /// write here is a put, and the repository decides where a document goes.</summary>
    internal readonly record struct Destination(SourceRepository Repository, PluginCopyKey Plugin);

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

        // The container may itself be embedded (a topic inside its quest's document); its container
        // document is whichever file's root actually holds it.
        var containerDocument = destination.Repository.ContainerDocument(
                destination.Plugin, destinationContainer, schemaReflector.GetSchemas(release))
            ?? throw NoDocumentCarries(destination.Plugin, containerFormKey);
        var withChild = ContainerDocumentEdits.WithChildAppended(
                codec, containerDocument.Body, release, containerDocument.RecordType, containerFormKey,
                container.SlotName, child.Body, child.RecordType)
            ?? throw new InvalidOperationException(
                $"{containerDocument.FormKey} was found holding {containerFormKey}, but its own text does not carry it.");

        destination.Repository.Put(destination.Plugin, containerDocument with { Body = withChild });
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

    // A GRUP's element order is binary-format position, so a replace must land at the record's
    // exact slot; xEdit's copy-into never drops a child the destination's copy already carries.
    private RecordEditResult ReplaceEmbeddedChildInPlace(
        PluginCopyKey sourcePlugin, RecordIdentity existing, SourceDocument replacement,
        Destination destination, GameRelease release)
    {
        var existingDocument = destination.Repository.Get(destination.Plugin, existing)
            ?? throw NoDocumentCarries(destination.Plugin, existing.FormKey);

        var withOwnFields = ContainerDocumentEdits.WithOwnFieldsReplaced(
            codec, existingDocument.Body, existing.RecordType, replacement.Body, replacement.RecordType, release);

        destination.Repository.Put(
            destination.Plugin,
            new SourceDocument(existing.FormKey, existing.RecordType, withOwnFields.EditorId, withOwnFields.Text));

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — replaced the existing embedded copy in place",
                existing.FormKey, sourcePlugin.Name, sourcePlugin.Origin, destination.Plugin.Name,
                destination.Plugin.Origin);
        }
        return RecordEditResult.Success();
    }

    // A top-level container the destination lacks: a block-placed exterior cell lands through the
    // spatial mint with its worldspace; everything else is a put, which places it.
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

        destination.Repository.Put(destination.Plugin, container);

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Auto-created {FormKey} as a Partial Form override in {DestinationPlugin} ({DestinationOrigin}) " +
                "— container for a copied child",
                formKey, destination.Plugin.Name, destination.Plugin.Origin);
        }
        return RecordEditResult.Success();
    }

    /// <summary>Lands an exterior CELL at its worldspace's block and sub-block, minting a bare Partial
    /// Form WRLD first when the destination has none: the put of a cell whose worldspace is absent
    /// refuses.</summary>
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

        if (Identity(destination, worldspaceFormKey, release) is null)
        {
            var sourceWorldspace = source.Identity(worldspaceFormKey)
                ?? throw new InvalidOperationException(
                    $"{source.Plugin.Name} does not hold {worldspaceFormKey} — the cell it carries names it as its worldspace.");
            destination.Repository.Put(
                destination.Plugin,
                BarePartialFormAncestor(worldspaceFormKey, sourceWorldspace.RecordType, release));
        }

        var sourceCell = source.Identity(cellFormKey)
            ?? throw new InvalidOperationException(
                $"{source.Plugin.Name} does not hold {cellFormKey} — its own placement named it.");
        var placed = cell with { RecordType = sourceCell.RecordType };

        destination.Repository.Put(
            destination.Plugin,
            placed with { Body = WithGridFrom(source.Body(sourceCell), placed, release) },
            placement);

        return RecordEditResult.Success();
    }

    // A cell minted bare as a placed reference's ancestor carries none of its own grid; the source
    // cell's document does, so the grid rides along as a member and the codec respells the result.
    private static JsonNode RequireParsed(string text) =>
        JsonNode.Parse(text) ?? throw new InvalidOperationException("Expected a document's text to parse as JSON.");

    private string WithGridFrom(string sourceCellText, SourceDocument cell, GameRelease release)
    {
        var grid = RequireParsed(sourceCellText).AsObject()[RecordTypeDispatch.CellGridMember];
        if (grid == null) return cell.Body;

        var withGrid = RequireParsed(cell.Body).AsObject();
        withGrid[RecordTypeDispatch.CellGridMember] = grid.DeepClone();
        return codec.RoundTrip(withGrid.ToJsonString(), release, cell.RecordType);
    }

    /// <summary>What the destination's tree names at <paramref name="formKey"/>, or null when nothing
    /// in it carries that key at the working tree.</summary>
    internal RecordIdentity? Identity(Destination destination, string formKey, GameRelease release) =>
        destination.Repository.IdentityOf(destination.Plugin, formKey, schemaReflector.GetSchemas(release));

    // The destination's own IdentityOf named this FormKey, so a document ought to carry it; only a
    // concurrent external edit to the tree closes that gap.
    private static InvalidOperationException NoDocumentCarries(PluginCopyKey plugin, string formKey) =>
        new($"{plugin.Name} holds {formKey}, but no document in its source tree carries it.");

    // Bare fields, no EditorID is xEdit parity (AddIfMissingInternal's Assign() runs only under
    // `if aDeepCopy`, hardcoded False for ancestors).
    private SourceDocument BarePartialFormAncestor(string formKey, string recordType, GameRelease release) =>
        new(formKey, recordType, null,
            RecordMint.BareDocument(
                codec, schemaReflector.GetSchemas(release)[recordType], release, formKey, editorId: null, partialForm: true));
}
