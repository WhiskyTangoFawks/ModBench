using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>The container half of both copy modes: a child lands inside its container's document,
/// copied in as an override with its own fields when the destination lacks it. One write path with
/// the write side (ADR-0007).</summary>
internal sealed class RecordCopy(WriteTargets targets, SchemaReflector schemaReflector, ILogger logger, RecordTextCodec codec)
{
    /// <summary>The tracked plugin a copy lands in: its repository and its key. No folder — every
    /// write here is a put, and the repository decides where a document goes.</summary>
    internal readonly record struct Destination(SourceRepository Repository, PluginAddress Plugin);

    /// <summary>Own fields only unless <paramref name="withChildren"/>, as every plain Copy as
    /// Override: a copied topic lands with no responses.</summary>
    internal RecordEditResult CopyEmbeddedChildAsOverride(
        CopySource source, SourceDocument child, DocumentContainment container,
        Destination destination, GameRelease release, bool replace, bool withChildren)
    {
        var formKey = child.FormKey;
        var landing = withChildren
            ? child
            : child with { Body = ContainerDocumentEdits.WithoutChildren(codec, child.Body, release, child.RecordType) };

        if (destination.Repository.FormKeysUsed(destination.Plugin).Contains(formKey))
        {
            if (Identity(destination, formKey, release) is not { } existing) return RefuseKeyWithNoDocument(destination, formKey);
            if (withChildren) return MergeChildrenIntoHeldCopy(source.Plugin, existing, child.Body, child.RecordType, destination, release);
            if (!replace) return RefuseHeldWithoutReplace(formKey, destination.Plugin);

            // Replaced in place, never duplicated.
            return ReplaceEmbeddedChildInPlace(source.Plugin, existing, landing, destination, release);
        }

        var appended = AppendEmbeddedChild(source, container, landing, destination, release);

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
    /// of the container's document, the container copied in with its own fields when absent,
    /// transitively.</summary>
    internal RecordEditResult AppendEmbeddedChild(
        CopySource source, DocumentContainment container, SourceDocument child,
        Destination destination, GameRelease release)
    {
        var containerFormKey = container.ParentFormKey;
        if (destination.Repository.Get(destination.Plugin, containerFormKey, schemaReflector.GetSchemas(release))
            is not { } containerDocument)
        {
            return CopyContainerInAround(source, container, child, destination, release);
        }

        // The container may itself be embedded (a topic inside its quest's document); its put lands
        // wherever the tree holds it.
        var withChild = ContainerDocumentEdits.WithChildAppended(
                codec, containerDocument.Body, release, containerDocument.RecordType, containerFormKey,
                container.SlotName, child.Body, child.RecordType)
            ?? throw new InvalidOperationException(
                $"{containerFormKey} was found, but its own text does not carry it.");

        destination.Repository.Put(destination.Plugin, containerDocument with { Body = withChild });
        return RecordEditResult.Success();
    }

    // A container the destination lacks is copied in around the child: itself a child lands in its
    // own container's slot by the same rule, a top-level one at a placement.
    private RecordEditResult CopyContainerInAround(
        CopySource source, DocumentContainment container, SourceDocument child,
        Destination destination, GameRelease release)
    {
        var containerFormKey = container.ParentFormKey;
        var sourceContainer = HeldBy(source, containerFormKey);
        if (targets.HighestOverrideVisibleToTheDestination(source, sourceContainer, destination, out var visibleText) is { } refused)
            return refused;
        var ownFields = OwnFieldsOf(source, sourceContainer, visibleText, release);
        var withChild = ownFields with
        {
            Body = ContainerDocumentEdits.WithChildAppended(
                       codec, ownFields.Body, release, ownFields.RecordType, containerFormKey, container.SlotName,
                       child.Body, child.RecordType)
                   ?? throw new InvalidOperationException(
                       $"The copy of {containerFormKey} does not carry its own FormKey."),
        };

        var landed = source.ContainerOf(sourceContainer) is { } ownParent
            ? AppendEmbeddedChild(source, ownParent, withChild, destination, release)
            : PlaceContainer(source, withChild, destination, release);

        if (landed.Applied && logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Landed {FormKey} in {DestinationPlugin} ({DestinationOrigin}) — copied in its container {ContainerFormKey} " +
                "as an override around it",
                child.FormKey, destination.Plugin.Name, destination.Plugin.Origin, containerFormKey);
        }
        return landed;
    }

    /// <summary>A deep copy overwrites the child records a destination holds, so it asks first.</summary>
    internal static RecordEditResult? RefuseIfHoldsChildRecords(
        Destination destination, string formKey, IEnumerable<string> childKeys)
    {
        var used = destination.Repository.FormKeysUsed(destination.Plugin);
        var held = childKeys.FirstOrDefault(used.Contains);
        return held is null
            ? null
            : RecordEditResult.Refused(
                RecordEditRefusal.DestinationHoldsRecord,
                $"{destination.Plugin.Name} ({destination.Plugin.Origin}) already holds {held}, a child record of " +
                $"{formKey}. Copy it again and confirm the replacement to overwrite the child records it holds.");
    }

    /// <summary>The destination keeps its own copy of the record: each child record it holds is
    /// overwritten, the others are added, and the ones only it holds stay.</summary>
    internal RecordEditResult MergeChildrenIntoHeldCopy(
        PluginAddress sourcePlugin, RecordIdentity existing, string sourceBody, string sourceRecordType,
        Destination destination, GameRelease release)
    {
        var existingDocument = DocumentOf(destination, existing);

        var elsewhere = FindHeldElsewhere(destination, sourceBody, sourceRecordType, existingDocument, release);
        var withChildren = ContainerDocumentEdits.WithChildRecordsMerged(
            codec, existingDocument.Body, existing.RecordType, sourceBody, sourceRecordType, release, elsewhere.Carried);

        RemoveHeldElsewhere(destination, elsewhere);
        destination.Repository.Put(
            destination.Plugin, new SourceDocument(existing.FormKey, existing.RecordType, existing.EditorId, withChildren));

        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Copied {FormKey} from {SourcePlugin} ({SourceOrigin}) as an override into {DestinationPlugin} " +
                "({DestinationOrigin}) — kept the copy it held and merged the child records into it",
                existing.FormKey, sourcePlugin.Name, sourcePlugin.Origin, destination.Plugin.Name, destination.Plugin.Origin);
        }
        return RecordEditResult.Success();
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
        CopySource source, SourceDocument container, Destination destination, GameRelease release)
    {
        var formKey = container.FormKey;
        var sourceCell = RecordTypeDispatch.For(release).IsCell(container.RecordType) ? source.Identity(formKey) : null;
        if (sourceCell is { } cell && source.WorldspaceOf(cell) is { } worldspace)
        {
            return PlaceExteriorCell(source, worldspace, container, destination, release);
        }

        destination.Repository.Put(destination.Plugin, container);

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
        CopySource source, string worldspaceFormKey, SourceDocument cell, Destination destination, GameRelease release)
    {
        var cellFormKey = cell.FormKey;
        if (destination.Repository.FormKeysUsed(destination.Plugin).Contains(cellFormKey))
            return RefuseKeyWithNoDocument(destination, cellFormKey);

        if (Identity(destination, worldspaceFormKey, release) is null)
        {
            var worldspace = HeldBy(source, worldspaceFormKey);
            if (targets.HighestOverrideVisibleToTheDestination(source, worldspace, destination, out var visibleText) is { } refused)
                return refused;
            destination.Repository.Put(destination.Plugin, OwnFieldsOf(source, worldspace, visibleText, release));
        }

        var sourceCell = source.Identity(cellFormKey)
            ?? throw new InvalidOperationException(
                $"{source.Plugin.Name} does not hold {cellFormKey} — its own worldspace named it.");
        PutExteriorCell(
            worldspaceFormKey, cell with { RecordType = sourceCell.RecordType }, source.Body(sourceCell), destination, release);
        return RecordEditResult.Success();
    }

    /// <summary>The put alone, which is what each cell of a worldspace needs: no read of the
    /// destination's tree to ask whether the cell or its worldspace is there. The grid is the one
    /// <paramref name="sourceCellText"/> carries.</summary>
    internal void PutExteriorCell(
        string worldspaceFormKey, SourceDocument cell, string sourceCellText, Destination destination, GameRelease release) =>
        destination.Repository.PutInWorldspace(
            destination.Plugin, cell with { Body = WithGridFrom(sourceCellText, cell, release) }, worldspaceFormKey);

    /// <summary>A cell the destination holds takes the source's own fields, its children kept and the
    /// source's merged into them, at the place it already has.</summary>
    internal void OverwriteHeldCell(
        SourceDocument sourceCell, Destination destination, GameRelease release)
    {
        var existing = Identity(destination, sourceCell.FormKey, release)
            ?? throw NoDocumentCarries(destination.Plugin, sourceCell.FormKey);
        var existingDocument = DocumentOf(destination, existing);

        var overwritten = ContainerDocumentEdits.WithRecordOverwritten(
            codec, existingDocument.Body, existing.RecordType, sourceCell.Body, sourceCell.RecordType, release);
        RemoveHeldElsewhere(destination, FindHeldElsewhere(destination, sourceCell.Body, sourceCell.RecordType, existingDocument, release));
        destination.Repository.Put(
            destination.Plugin, new SourceDocument(sourceCell.FormKey, existing.RecordType, overwritten.EditorId, overwritten.Text));
    }

    private static SourceDocument DocumentOf(Destination destination, RecordIdentity existing) =>
        destination.Repository.Get(destination.Plugin, existing) ?? throw NoDocumentCarries(destination.Plugin, existing.FormKey);

    /// <summary>The child records the destination holds in another document leave it, and the copy
    /// lands each where the source has it. <c>Carried</c> is the text of those with children.</summary>
    internal sealed record HeldElsewhere(
        IReadOnlyList<RecordIdentity> Records, IReadOnlyList<(string Text, string? RecordType)> Carried);

    internal HeldElsewhere FindHeldElsewhere(
        Destination destination, string sourceBody, string sourceRecordType, SourceDocument? destinationUnit, GameRelease release)
    {
        var used = destination.Repository.FormKeysUsed(destination.Plugin);
        var inUnit = destinationUnit is null
            ? new HashSet<string>()
            : ContainerDocumentEdits.ChildFormKeys(codec, destinationUnit.Body, release, destinationUnit.RecordType).ToHashSet();
        var schemas = schemaReflector.GetSchemas(release);
        var records = new List<RecordIdentity>();
        var carried = new List<(string Text, string? RecordType)>();
        foreach (var key in ContainerDocumentEdits.ChildFormKeys(codec, sourceBody, release, sourceRecordType).Where(used.Contains))
        {
            if (inUnit.Contains(key) || Identity(destination, key, release) is not { } elsewhere) continue;
            if (!ContainerChildFields.HasChildFields(elsewhere.RecordType, release)) records.Add(elsewhere);
            else if (destination.Repository.ContainerOf(destination.Plugin, elsewhere, schemas) is not null)
            {
                records.Add(elsewhere);
                carried.Add((DocumentOf(destination, elsewhere).Body, elsewhere.RecordType));
            }
        }
        return new HeldElsewhere(records, carried);
    }

    /// <summary><paramref name="body"/> with the records held elsewhere overwritten by its own.</summary>
    internal string CarryingHeldElsewhere(HeldElsewhere elsewhere, string body, string recordType, GameRelease release) =>
        elsewhere.Carried.Count == 0
            ? body
            : ContainerDocumentEdits.WithChildRecordsMerged(codec, body, recordType, body, recordType, release, elsewhere.Carried);

    internal static void RemoveHeldElsewhere(Destination destination, HeldElsewhere elsewhere)
    {
        foreach (var record in elsewhere.Records) destination.Repository.Remove(destination.Plugin, record);
    }

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
        destination.Repository.Get(destination.Plugin, formKey, schemaReflector.GetSchemas(release))?.Identity;

    internal static RecordEditResult RefuseHeldWithoutReplace(string formKey, PluginAddress destination) =>
        RecordEditResult.Refused(
            RecordEditRefusal.DestinationHoldsRecord,
            $"{destination.Name} ({destination.Origin}) already holds {formKey}. Copy it again and confirm " +
            "the replacement to copy over it.");

    /// <summary>The refusal for a FormKey the destination uses and the tree names no record for: held only at the
    /// last commit, or named by a document the codec cannot place.</summary>
    internal static RecordEditResult RefuseKeyWithNoDocument(Destination destination, string formKey)
    {
        var plugin = destination.Plugin;
        return destination.Repository.HeldOnlyAtLastCommit(plugin, formKey)
            ? RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{plugin.Name} ({plugin.Origin}) holds {formKey} at the last commit, and its working tree deletes " +
                "it. Commit or discard that deletion in Source Control, then copy it again.")
            : RecordEditResult.Refused(
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

    // The container as xEdit copies it in: the copy the destination can see, its own fields only.
    private SourceDocument OwnFieldsOf(CopySource source, RecordIdentity container, string? visibleText, GameRelease release)
    {
        var visible = visibleText is null
            ? source.Document(container)
            : new SourceDocument(container.FormKey, container.RecordType, WriteTargets.EditorIdOf(visibleText), visibleText);
        return visible with { Body = ContainerDocumentEdits.WithoutChildren(codec, visible.Body, release, visible.RecordType) };
    }
}
