using System.Diagnostics.CodeAnalysis;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Resolution;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>The container half of both copy modes: a child lands inside its container's document, the
/// container copied in when absent, as a Partial Form where the game allows (ADR-0007).</summary>
internal sealed class RecordCopy(LoadOrderResolution resolution, SchemaReflector schemaReflector, ILogger logger)
{
    /// <summary>The tracked plugin a copy lands in: its repository and its key. No folder — every
    /// write here is a put, and the repository decides where a document goes.</summary>
    internal readonly record struct Destination(SourceRepository Repository, PluginAddress Plugin);

    /// <summary>A copy of a child the destination lacks, as every Copy as Override: own fields only, so a copied
    /// topic lands with no responses.</summary>
    internal SourceAnswer<RecordEditResult> CopyNewEmbeddedChildAsOverride(
        CopySource source, SourceDocument child, DocumentContainment container,
        Destination destination, GameRelease release)
    {
        var landing = child with { Body = ContainerDocumentEdits.WithoutChildren(child.Body, release, child.RecordType) };

        if (!SourceTransaction.Atomically(
                destination.Repository, transaction => AppendEmbeddedChild(transaction, source, container, landing, destination, release))
            .Holds(out var appended, out var unread))
        {
            return unread is SourceFailure.SlotHeld held ? RefuseSlotHeldByAnotherRecord(destination.Plugin, held) : unread;
        }

        if (appended.Applied && logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — inside {ContainerFormKey}'s {SlotName} slot",
                child.FormKey, source.Plugin.Name, source.Plugin.Origin, destination.Plugin.Name, destination.Plugin.Origin,
                container.ParentFormKey, container.SlotName);
        }
        return appended;
    }

    private static RecordEditResult RefuseSlotHeldByAnotherRecord(PluginAddress destinationPlugin, SourceFailure.SlotHeld held) =>
        RecordEditResult.Refused(
            RecordEditRefusal.ChildSlotHeldByAnotherRecord,
            $"{destinationPlugin.Name} ({destinationPlugin.Origin}) holds another record where the copy puts one: {held.Reason}");

    /// <summary>The container rule: the child lands at the end of its slot in the destination's copy
    /// of its container, which is copied in with its own fields when absent, transitively.</summary>
    internal SourceAnswer<RecordEditResult> AppendEmbeddedChild(
        SourceTransaction transaction, CopySource source, DocumentContainment container, SourceDocument child,
        Destination destination, GameRelease release)
    {
        var containerFormKey = container.ParentFormKey;
        if (!destination.Repository.Get(destination.Plugin, containerFormKey).Holds(out var held, out var unread)) return unread;
        if (held is not { } containerDocument)
        {
            return CopyContainerInAround(transaction, source, container, child, destination, release);
        }

        transaction.Apply(destination.Repository.ChangesToPutChild(
            destination.Plugin, containerDocument.Identity, container.SlotName, child));
        return RecordEditResult.Success();
    }

    // A container the destination lacks is copied in around the child: itself a child lands in its
    // own container's slot by the same rule, a top-level one at a placement.
    private SourceAnswer<RecordEditResult> CopyContainerInAround(
        SourceTransaction transaction, CopySource source, DocumentContainment container, SourceDocument child,
        Destination destination, GameRelease release)
    {
        var containerFormKey = container.ParentFormKey;
        if (!HeldBy(source, containerFormKey).Holds(out var sourceContainer, out var why))
            return WriteTargets.RefuseUnreadableSource(containerFormKey, why);
        if (!TryCopyIn(source, sourceContainer, destination, release, out var ownFields, out var refused)) return refused;
        if (!source.ContainerOf(sourceContainer).Holds(out var parentOfContainer, out why))
            return WriteTargets.RefuseUnreadableSource(containerFormKey, why);
        if (!(parentOfContainer is { } ownParent
                ? AppendEmbeddedChild(transaction, source, ownParent, ownFields, destination, release)
                : PlaceContainer(transaction, source, ownFields, destination, release)).Holds(out var landed, out var unread))
        {
            return unread;
        }
        if (!landed.Applied) return landed;

        transaction.Apply(destination.Repository.ChangesToPutChild(destination.Plugin, ownFields.Identity, container.SlotName, child));

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Landed {FormKey} in {DestinationPlugin} ({DestinationOrigin}) — copied in its container {ContainerFormKey} " +
                "around it",
                child.FormKey, destination.Plugin.Name, destination.Plugin.Origin, containerFormKey);
        }
        return landed;
    }

    // A top-level container the destination lacks: an exterior cell lands through the spatial mint
    // with its worldspace; everything else is a put, which places it.
    private SourceAnswer<RecordEditResult> PlaceContainer(
        SourceTransaction transaction, CopySource source, SourceDocument container, Destination destination, GameRelease release)
    {
        var formKey = container.FormKey;
        CopyRead<string?> worldspaceRead = (string?)null;
        if (RecordTypes.For(release).IsCell(container.RecordType))
            worldspaceRead = source.Identity(formKey).Then<string?>(cell => cell is { } held ? source.WorldspaceOf(held) : (string?)null);
        if (!worldspaceRead.Holds(out var worldspace, out var why)) return WriteTargets.RefuseUnreadableSource(formKey, why);
        if (worldspace is not null)
        {
            return PlaceExteriorCell(transaction, source, worldspace, container, destination, release);
        }

        transaction.Apply(destination.Repository.ChangesToPut(destination.Plugin, container));

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied in {FormKey} as an override in {DestinationPlugin} ({DestinationOrigin}) " +
                "— container for a copied child",
                formKey, destination.Plugin.Name, destination.Plugin.Origin);
        }
        return RecordEditResult.Success();
    }

    /// <summary>Lands an exterior CELL in <paramref name="worldspaceFormKey"/>, copying the WRLD in with
    /// its own fields first when the destination has none: the put of a cell whose worldspace is
    /// absent refuses.</summary>
    internal SourceAnswer<RecordEditResult> PlaceExteriorCell(
        SourceTransaction transaction, CopySource source, string worldspaceFormKey, SourceDocument cell,
        Destination destination, GameRelease release)
    {
        var cellFormKey = cell.FormKey;
        if (!destination.Repository.FormKeysUsed(destination.Plugin).Holds(out var used, out var unread)) return unread;
        if (used.Contains(cellFormKey)) return RefuseKeyWithNoDocument(destination, cellFormKey);

        SourceDocument? worldspaceCopy = null;
        if (!Identity(destination, worldspaceFormKey).Holds(out var destinationWorldspace, out unread)) return unread;
        if (destinationWorldspace is null)
        {
            if (!HeldBy(source, worldspaceFormKey).Holds(out var worldspace, out var unreadSource))
                return WriteTargets.RefuseUnreadableSource(worldspaceFormKey, unreadSource);
            if (!TryCopyIn(source, worldspace, destination, release, out var copied, out var refused)) return refused;
            worldspaceCopy = copied;
        }

        if (!source.Identity(cellFormKey).Holds(out var named, out var why)) return WriteTargets.RefuseUnreadableSource(cellFormKey, why);
        var sourceCell = named
            ?? throw new InvalidOperationException(
                $"{source.Plugin.Name} does not hold {cellFormKey} — its own worldspace named it.");
        if (!source.Body(sourceCell).Holds(out var sourceCellText, out why)) return WriteTargets.RefuseUnreadableSource(cellFormKey, why);
        var landing = WithGridFrom(sourceCellText, cell with { RecordType = sourceCell.RecordType }, release);
        var (repository, plugin) = destination;
        if (worldspaceCopy is not null) transaction.Apply(repository.ChangesToPut(plugin, worldspaceCopy));
        transaction.Apply(repository.ChangesToPutInWorldspace(plugin, landing, worldspaceFormKey));
        return RecordEditResult.Success();
    }

    private static JsonNode RequireParsed(string text) =>
        JsonNode.Parse(text) ?? throw new InvalidOperationException("Expected a document's text to parse as JSON.");

    private static SourceDocument WithGridFrom(string sourceCellText, SourceDocument cell, GameRelease release)
    {
        var grid = RequireParsed(sourceCellText).AsObject()[RecordTypes.CellGridMember];
        if (grid == null) return cell;

        var withGrid = RequireParsed(cell.Body).AsObject();
        withGrid[RecordTypes.CellGridMember] = grid.DeepClone();
        return cell with { Body = RecordTextCodec.RoundTrip(withGrid.ToJsonString(), release, cell.RecordType) };
    }

    /// <summary>What the destination's tree names at <paramref name="formKey"/>, or null when nothing
    /// in it carries that key at the working tree.</summary>
    internal static SourceAnswer<RecordIdentity?> Identity(Destination destination, string formKey) =>
        destination.Repository.Get(destination.Plugin, formKey).Then(held => SourceAnswer.Of(held?.Identity));

    internal static RecordEditResult RefuseHeldWithoutReplace(string formKey, PluginAddress destination) =>
        RecordEditResult.Refused(
            RecordEditRefusal.DestinationHoldsRecord,
            $"{destination.Name} ({destination.Origin}) already holds {formKey}. Copy it again and confirm " +
            "the replacement to copy over it.");

    /// <summary>The refusal for a FormKey the destination uses and the tree names no record for: a document
    /// the codec cannot place names it.</summary>
    internal static RecordEditResult RefuseKeyWithNoDocument(Destination destination, string formKey)
    {
        var plugin = destination.Plugin;
        return RecordEditResult.Refused(
            RecordEditRefusal.FormKeyCollision,
            $"{plugin.Name} ({plugin.Origin}) uses {formKey}, but no document in its source tree carries it. " +
            "Check the Source Control panel.");
    }

    // The destination's own tree named this FormKey, so a document ought to carry it; only a
    // concurrent external edit to the tree closes that gap.
    internal static InvalidOperationException NoDocumentCarries(PluginAddress plugin, string formKey) =>
        new($"{plugin.Name} holds {formKey}, but no document in its source tree carries it.");

    private static CopyRead<RecordIdentity> HeldBy(CopySource source, string containerFormKey) =>
        source.Identity(containerFormKey).Then<RecordIdentity>(held => held
            ?? throw new InvalidOperationException(
                $"{source.Plugin.Name} does not hold {containerFormKey}, which a copied record names as its container."));

    private bool TryCopyIn(
        CopySource source, RecordIdentity container, Destination destination, GameRelease release,
        [NotNullWhen(true)] out SourceDocument? copy, [NotNullWhen(false)] out RecordEditResult? refused)
    {
        (copy, refused) = (null, null);
        var schema = schemaReflector.GetSchemas(release)[container.RecordType];
        if (!TemporaryExterior(source, container, release).Holds(out var temporaryExterior, out var why))
        {
            refused = WriteTargets.RefuseUnreadableSource(container.FormKey, why);
            return false;
        }
        if (CanBePartial.Of(schema, release, container.FormKey, temporaryExterior) is CanBePartial.Verdict.Can)
        {
            if (!source.Document(container).Holds(out var document, out why))
            {
                refused = WriteTargets.RefuseUnreadableSource(container.FormKey, why);
                return false;
            }
            copy = PartialFormOf(document, schema, release);
            return true;
        }

        if (resolution.HighestOverrideVisibleToTheDestination(
                source, container, destination.Repository, destination.Plugin, out var visibleText) is { } visibleRefusal)
        {
            refused = visibleRefusal;
            return false;
        }
        if (!OwnFieldsOf(source, container, visibleText, release).Holds(out copy, out why))
        {
            refused = WriteTargets.RefuseUnreadableSource(container.FormKey, why);
            return false;
        }
        return true;
    }

    private static CopyRead<bool?> TemporaryExterior(CopySource source, RecordIdentity container, GameRelease release)
    {
        if (!RecordTypes.For(release).IsCell(container.RecordType)) return (bool?)null;
        return source.RecordFlags(container).Then<bool?>(flags =>
            source.ContainerOf(container).Then<bool?>(held =>
                source.WorldspaceOf(container).Then<bool?>(worldspace =>
                    CanBePartial.TemporaryExterior((flags & PersistentFlag.Bit) != 0, held is not null, worldspace is null))));
    }

    private static SourceDocument PartialFormOf(SourceDocument container, RecordTableSchema schema, GameRelease release)
    {
        var body = ContainerDocumentEdits.WithoutChildren(container.Body, release, container.RecordType);
        var record = RequireParsed(body).AsObject();
        return RecordEmptying.MakePartialForm(record, schema, release)
            ? container with { Body = RecordTextCodec.RoundTrip(record.ToJsonString(), release, container.RecordType) }
            : container with { Body = body };
    }

    // The container as xEdit copies it in: the copy the destination can see, its own fields only.
    private static CopyRead<SourceDocument> OwnFieldsOf(CopySource source, RecordIdentity container, string? visibleText, GameRelease release)
    {
        var visible = visibleText is null
            ? source.Document(container)
            : new SourceDocument(container.FormKey, container.RecordType, EditorIds.In(visibleText), visibleText);
        return visible.Then<SourceDocument>(document =>
            document with { Body = ContainerDocumentEdits.WithoutChildren(document.Body, release, document.RecordType) });
    }
}
