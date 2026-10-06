using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands;

/// <summary>The Create gesture's handler (ADR-0014): mints a bare record (plugins.md, Create record, story 2)
/// under the next free FormKey: a new source file, the end of its container's slot, or a worldspace's grid.</summary>
public sealed class CreateRecordHandler
{
    private readonly WriteTargets _targets;
    private readonly LoadOrderHolder _loadOrder;
    private readonly RecordTextCodec _codec;
    private readonly SchemaReflector _schemaReflector;
    private readonly ILogger<CreateRecordHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Commands.Composition) rather than the host naming a type it cannot see.
    internal CreateRecordHandler(
        WriteTargets targets,
        LoadOrderHolder loadOrder,
        RecordTextCodec codec,
        SchemaReflector schemaReflector,
        ILogger<CreateRecordHandler> logger)
    {
        (_targets, _loadOrder, _codec, _schemaReflector, _logger) =
            (targets, loadOrder, codec, schemaReflector, logger);
    }

    public RecordEditResult CreateRecord(
        PluginAddress plugin, string recordType, string? container = null, GridPosition? position = null) =>
        WriteFailure.Refused(
            () => MintRecord(plugin, recordType, container, position),
            $"Could not write the source file for the new {recordType}", _logger);

    private static RecordEditResult MalformedPosition(string why) =>
        RecordEditResult.Refused(RecordEditRefusal.InvalidEnvelope, $"A grid position is for a cell in a worldspace, and the request {why}.");

    private static JsonObject ObjectOf(string document, string what) =>
        JsonNode.Parse(document) as JsonObject
            ?? throw new InvalidOperationException($"Expected {what}'s document to hold a JSON object.");

    private static string AsInteriorCell(string bareCell)
    {
        var cell = ObjectOf(bareCell, "a minted cell");
        PlacedCell.MarkInterior(cell);
        return cell.ToJsonString();
    }

    private RecordEditResult MintRecord(PluginAddress plugin, string recordType, string? container, GridPosition? position)
    {
        if (ItemWrite.RefuseWithoutGit() is { } gitMissing) return gitMissing;
        if (_targets.RefuseUnlessTrackedAndLoaded(plugin, out var openedRepository) is { } blocked) return blocked;
        var repository = openedRepository
            ?? throw new InvalidOperationException("Expected RefuseUnlessTrackedAndLoaded to open a repository when it does not refuse.");

        var release = _loadOrder.Current.GameRelease;
        var schemas = _schemaReflector.GetSchemas(release);
        if (recordType == PluginHeader.RecordType || !schemas.TryGetValue(recordType, out var schema))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordTypeNotFound, $"'{recordType}' is not a creatable record type.");
        }
        if (container is not null) return MintChild(repository, plugin, recordType, schema, release, container, position);
        if (position is not null) return MalformedPosition("names no container");
        if (!CreatableRecordTypes.Includes(recordType, release))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.HeldInAnotherRecordNotYetSupported,
                $"'{recordType}' is held inside another record's document, and creating one is not supported yet.");
        }

        if (FormKeyAllocator.Over(repository, plugin, release).Next(out var targetFormKey)
            is { } refusedTarget) return refusedTarget;

        var body = RecordMint.BareDocument(_codec, schema, release, targetFormKey, editorId: null);
        if (RecordTypeDispatch.For(release).IsCell(recordType)) body = AsInteriorCell(body);

        repository.Put(plugin, new SourceDocument(targetFormKey, recordType, null, body));

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Created {RecordType} {FormKey} in {Plugin} ({Origin}) — new working-tree source document",
                recordType, targetFormKey, plugin.Name, plugin.Origin);
        }
        return RecordEditResult.Success(targetFormKey);
    }

    private RecordEditResult MintChild(
        SourceRepository repository, PluginAddress plugin, string recordType, RecordTableSchema schema, GameRelease release,
        string container, GridPosition? position)
    {
        if (!_targets.TryResolveEditTarget(plugin, container, out var target, out var containerDocument, out var unresolved))
            return unresolved;
        var containerType = target.Identity.RecordType;
        var dispatch = RecordTypeDispatch.For(release);
        var exteriorCell = dispatch.IsWorldspace(containerType) && dispatch.IsCell(recordType);
        if (position is not null && !exteriorCell) return MalformedPosition($"creates a '{recordType}' in {container}");

        var schemas = _schemaReflector.GetSchemas(release);
        CellPlace? place;
        try
        {
            place = dispatch.IsCell(containerType) ? repository.CellStructureOf(plugin, target.Identity)?.Place : null;
        }
        catch (UnreadableSourceDocumentException ex)
        {
            return WriteTargets.RefuseUnreadable(container, ex.Message);
        }

        using var parsed = JsonDocument.Parse(containerDocument.Body);
        var childSlot = ChildRecordTypes.SlotFor(containerType, parsed.RootElement, place, recordType, schemas, release);
        var containerHoldsIt = childSlot is not ChildSlot.NotHeld;
        if (exteriorCell && containerHoldsIt)
        {
            return position is { X: int x, Y: int y }
                ? CreateCellAt(repository, plugin, recordType, schemas, release, container, (x, y))
                : RecordEditResult.Refused(
                    RecordEditRefusal.InvalidEnvelope, $"A cell created in the worldspace {container} takes a grid position, both x and y.");
        }
        switch (childSlot)
        {
            case ChildSlot.Open(var slot):
                var root = JsonObject.Create(parsed.RootElement)
                    ?? throw new InvalidOperationException($"Expected {container}'s document to hold a JSON object.");
                return AppendChild(repository, plugin, recordType, schema, release, new Landing(containerDocument, root, slot));
            case ChildSlot.Filled(var slot, var held):
                return RecordEditResult.Refused(
                    RecordEditRefusal.ChildSlotHeldByAnotherRecord,
                    $"{container} already holds {held} as its {slot}, and holds one at most. Delete it to create another.");
            default:
                return RecordEditResult.Refused(
                    RecordEditRefusal.ContainerCannotHoldType, $"{container} cannot hold a new '{recordType}' where it sits.");
        }
    }

    private RecordEditResult CreateCellAt(
        SourceRepository repository, PluginAddress plugin, string recordType, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        GameRelease release, string worldspace, (int X, int Y) grid)
    {
        var at = $"at {grid.X}, {grid.Y} of {worldspace}";
        switch (GridCells.At(_targets, repository, plugin, schemas, worldspace, grid, worldspace, $"whether a cell sits {at}"))
        {
            case GridCells.Holder.Unreadable(var why):
                return why;
            case GridCells.Holder.Plugins(var held):
                return RecordEditResult.Refused(
                    RecordEditRefusal.ChildSlotHeldByAnotherRecord, $"{plugin.Name} already holds the cell {held.FormKey} {at}.");
            case GridCells.Holder.Masters(var copy, var masterCell):
                return RecordEditResult.Refused(
                    RecordEditRefusal.ChildSlotHeldByAnotherRecord,
                    $"{copy.Plugin.Name} holds the cell {masterCell} {at}. \"{WriteTargets.CopyCommandTitle}\" as an override brings it into {plugin.Name}.");
        }

        if (GridCells.Mint(repository, plugin, _codec, schemas[recordType], release, grid, out var cell) is { } exhausted) return exhausted;
        var formKey = GridCells.FormKeyOf(cell);
        var text = _codec.RoundTrip(cell.ToJsonString(), release, recordType);
        repository.PutInWorldspace(plugin, new SourceDocument(formKey, recordType, null, text), worldspace);

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Created cell {FormKey} in {Plugin} ({Origin}) — at grid {X}, {Y} of {Worldspace}",
                formKey, plugin.Name, plugin.Origin, grid.X, grid.Y, worldspace);
        }
        return RecordEditResult.Success(formKey);
    }

    private sealed record Landing(SourceDocument Container, JsonObject Root, string Slot);

    private RecordEditResult AppendChild(
        SourceRepository repository, PluginAddress plugin, string recordType, RecordTableSchema schema, GameRelease release,
        Landing landing)
    {
        var (container, root, slot) = landing;
        if (FormKeyAllocator.Over(repository, plugin, release).Next(out var formKey) is { } refusedTarget) return refusedTarget;
        var child = ObjectOf(RecordMint.BareDocument(_codec, schema, release, formKey, editorId: null), $"the minted {recordType}");
        if (!PlacedCell.TryAsCreatedIn(child, slot, root, release, out var unplaceable))
            return RecordEditResult.Refused(RecordEditRefusal.HeldInAnotherRecordNotYetSupported, unplaceable);
        var withChild = ContainerDocumentEdits.WithChildAppended(
                _codec, container.Body, release, container.RecordType, container.FormKey, slot, child.ToJsonString(), recordType)
            ?? throw new InvalidOperationException($"{container.FormKey} was found, but its own text does not carry it.");

        SourceTransaction.Atomically(repository, transaction =>
            transaction.Apply(repository, repository.ChangesToRewrite(plugin, container with { Body = withChild })));

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Created {RecordType} {FormKey} in {Plugin} ({Origin}) — at the end of {Container}'s {Slot}",
                recordType, formKey, plugin.Name, plugin.Origin, container.FormKey, slot);
        }
        return RecordEditResult.Success(formKey);
    }
}
