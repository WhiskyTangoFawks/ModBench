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
internal sealed class RecordCopy(LoadOrderResolution resolution, SchemaReflector schemaReflector, ILogger logger, RecordTextCodec codec)
{
    /// <summary>The tracked plugin a copy lands in: its repository and its key. No folder — every
    /// write here is a put, and the repository decides where a document goes.</summary>
    internal readonly record struct Destination(SourceRepository Repository, PluginAddress Plugin);

    /// <summary>Own fields only, as every Copy as Override: a copied topic lands with no responses.</summary>
    internal RecordEditResult CopyEmbeddedChildAsOverride(
        CopySource source, SourceDocument child, DocumentContainment container,
        Destination destination, GameRelease release, bool replace)
    {
        var formKey = child.FormKey;
        var landing = child with { Body = ContainerDocumentEdits.WithoutChildren(codec, child.Body, release, child.RecordType) };

        if (destination.Repository.FormKeysUsed(destination.Plugin).Contains(formKey))
        {
            if (Identity(destination, formKey, release) is not { } existing) return RefuseKeyWithNoDocument(destination, formKey);
            if (!replace) return RefuseHeldWithoutReplace(formKey, destination.Plugin);

            // Replaced in place, never duplicated.
            return ReplaceEmbeddedChildInPlace(source.Plugin, existing, landing, destination, release);
        }

        var appended = SourceTransaction.Atomically(
            destination.Repository, transaction => AppendEmbeddedChild(transaction, source, container, landing, destination, release));

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
    /// of its container, which is copied in with its own fields when absent, transitively.</summary>
    internal RecordEditResult AppendEmbeddedChild(
        SourceTransaction transaction, CopySource source, DocumentContainment container, SourceDocument child,
        Destination destination, GameRelease release)
    {
        var containerFormKey = container.ParentFormKey;
        if (destination.Repository.Get(destination.Plugin, containerFormKey, schemaReflector.GetSchemas(release))
            is not { } containerDocument)
        {
            return CopyContainerInAround(transaction, source, container, child, destination, release);
        }

        // The container may itself be embedded (a topic inside its quest's document); its put lands
        // wherever the tree holds it.
        var withChild = ContainerDocumentEdits.WithChildAppended(
                codec, containerDocument.Body, release, containerDocument.RecordType, containerFormKey,
                container.SlotName, child.Body, child.RecordType)
            ?? throw new InvalidOperationException(
                $"{containerFormKey} was found, but its own text does not carry it.");

        transaction.Apply(destination.Repository.ChangesToPut(destination.Plugin, containerDocument with { Body = withChild }));
        return RecordEditResult.Success();
    }

    // A container the destination lacks is copied in around the child: itself a child lands in its
    // own container's slot by the same rule, a top-level one at a placement.
    private RecordEditResult CopyContainerInAround(
        SourceTransaction transaction, CopySource source, DocumentContainment container, SourceDocument child,
        Destination destination, GameRelease release)
    {
        var containerFormKey = container.ParentFormKey;
        var sourceContainer = HeldBy(source, containerFormKey);
        if (!TryCopyIn(source, sourceContainer, destination, release, out var ownFields, out var refused)) return refused;
        var withChild = ownFields with
        {
            Body = ContainerDocumentEdits.WithChildAppended(
                       codec, ownFields.Body, release, ownFields.RecordType, containerFormKey, container.SlotName,
                       child.Body, child.RecordType)
                   ?? throw new InvalidOperationException(
                       $"The copy of {containerFormKey} does not carry its own FormKey."),
        };

        var landed = source.ContainerOf(sourceContainer) is { } ownParent
            ? AppendEmbeddedChild(transaction, source, ownParent, withChild, destination, release)
            : PlaceContainer(transaction, source, withChild, destination, release);

        if (landed.Applied && logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Landed {FormKey} in {DestinationPlugin} ({DestinationOrigin}) — copied in its container {ContainerFormKey} " +
                "around it",
                child.FormKey, destination.Plugin.Name, destination.Plugin.Origin, containerFormKey);
        }
        return landed;
    }

    // A GRUP's element order is binary-format position, so a replace must land at the record's
    // exact slot; xEdit's copy-into never drops a child the destination's copy already carries.
    private RecordEditResult ReplaceEmbeddedChildInPlace(
        PluginAddress sourcePlugin, RecordIdentity existing, SourceDocument replacement,
        Destination destination, GameRelease release)
    {
        var existingDocument = DocumentOf(destination, existing);

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

    // A top-level container the destination lacks: an exterior cell lands through the spatial mint
    // with its worldspace; everything else is a put, which places it.
    private RecordEditResult PlaceContainer(
        SourceTransaction transaction, CopySource source, SourceDocument container, Destination destination, GameRelease release)
    {
        var formKey = container.FormKey;
        var sourceCell = RecordTypeDispatch.For(release).IsCell(container.RecordType) ? source.Identity(formKey) : null;
        if (sourceCell is { } cell && source.WorldspaceOf(cell) is { } worldspace)
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
    internal RecordEditResult PlaceExteriorCell(
        SourceTransaction transaction, CopySource source, string worldspaceFormKey, SourceDocument cell,
        Destination destination, GameRelease release)
    {
        var cellFormKey = cell.FormKey;
        if (destination.Repository.FormKeysUsed(destination.Plugin).Contains(cellFormKey))
            return RefuseKeyWithNoDocument(destination, cellFormKey);

        SourceDocument? worldspaceCopy = null;
        if (Identity(destination, worldspaceFormKey, release) is null)
        {
            var worldspace = HeldBy(source, worldspaceFormKey);
            if (!TryCopyIn(source, worldspace, destination, release, out var copied, out var refused)) return refused;
            worldspaceCopy = copied;
        }

        var sourceCell = source.Identity(cellFormKey)
            ?? throw new InvalidOperationException(
                $"{source.Plugin.Name} does not hold {cellFormKey} — its own worldspace named it.");
        var landing = WithGridFrom(source.Body(sourceCell), cell with { RecordType = sourceCell.RecordType }, release);
        var (repository, plugin) = destination;
        if (worldspaceCopy is not null) transaction.Apply(repository.ChangesToPut(plugin, worldspaceCopy));
        transaction.Apply(repository.ChangesToPutInWorldspace(plugin, landing, worldspaceFormKey));
        return RecordEditResult.Success();
    }

    private static SourceDocument DocumentOf(Destination destination, RecordIdentity existing) =>
        destination.Repository.RecordOf(destination.Plugin, existing) ?? throw NoDocumentCarries(destination.Plugin, existing.FormKey);

    private static JsonNode RequireParsed(string text) =>
        JsonNode.Parse(text) ?? throw new InvalidOperationException("Expected a document's text to parse as JSON.");

    private SourceDocument WithGridFrom(string sourceCellText, SourceDocument cell, GameRelease release)
    {
        var grid = RequireParsed(sourceCellText).AsObject()[RecordTypeDispatch.CellGridMember];
        if (grid == null) return cell;

        var withGrid = RequireParsed(cell.Body).AsObject();
        withGrid[RecordTypeDispatch.CellGridMember] = grid.DeepClone();
        return cell with { Body = codec.RoundTrip(withGrid.ToJsonString(), release, cell.RecordType) };
    }

    /// <summary>What the destination's tree names at <paramref name="formKey"/>, or null when nothing
    /// in it carries that key at the working tree.</summary>
    internal RecordIdentity? Identity(Destination destination, string formKey, GameRelease release) =>
        destination.Repository.Get(destination.Plugin, formKey, schemaReflector.GetSchemas(release))?.Identity;

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

    private static RecordIdentity HeldBy(CopySource source, string containerFormKey) =>
        source.Identity(containerFormKey)
        ?? throw new InvalidOperationException(
            $"{source.Plugin.Name} does not hold {containerFormKey}, which a copied record names as its container.");

    private bool TryCopyIn(
        CopySource source, RecordIdentity container, Destination destination, GameRelease release,
        [NotNullWhen(true)] out SourceDocument? copy, [NotNullWhen(false)] out RecordEditResult? refused)
    {
        refused = null;
        var schema = schemaReflector.GetSchemas(release)[container.RecordType];
        if (CanBePartial.Of(schema, release, container.FormKey, TemporaryExterior(source, container, release)) is CanBePartial.Verdict.Can)
        {
            copy = PartialFormOf(source.Document(container), schema, release);
            return true;
        }

        copy = null;
        if (resolution.HighestOverrideVisibleToTheDestination(
                source, container, destination.Repository, destination.Plugin, out var visibleText) is { } visibleRefusal)
        {
            refused = visibleRefusal;
            return false;
        }
        copy = OwnFieldsOf(source, container, visibleText, release);
        return true;
    }

    private static bool? TemporaryExterior(CopySource source, RecordIdentity container, GameRelease release) =>
        RecordTypeDispatch.For(release).IsCell(container.RecordType)
            ? CanBePartial.TemporaryExterior(
                (source.RecordFlags(container) & PersistentFlag.Bit) != 0,
                source.ContainerOf(container) is not null,
                source.WorldspaceOf(container) is null)
            : null;

    private SourceDocument PartialFormOf(SourceDocument container, RecordTableSchema schema, GameRelease release)
    {
        var body = ContainerDocumentEdits.WithoutChildren(codec, container.Body, release, container.RecordType);
        var record = RequireParsed(body).AsObject();
        return RecordEmptying.MakePartialForm(record, schema)
            ? container with { Body = codec.RoundTrip(record.ToJsonString(), release, container.RecordType) }
            : container with { Body = body };
    }

    // The container as xEdit copies it in: the copy the destination can see, its own fields only.
    private SourceDocument OwnFieldsOf(CopySource source, RecordIdentity container, string? visibleText, GameRelease release)
    {
        var visible = visibleText is null
            ? source.Document(container)
            : new SourceDocument(container.FormKey, container.RecordType, EditorIds.In(visibleText), visibleText);
        return visible with { Body = ContainerDocumentEdits.WithoutChildren(codec, visible.Body, release, visible.RecordType) };
    }
}
