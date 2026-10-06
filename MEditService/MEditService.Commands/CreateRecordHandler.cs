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
/// under the next free FormKey, as a new source file or at the end of its container's slot.</summary>
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

    private static RecordEditResult NotYetSupported(string what) =>
        RecordEditResult.Refused(RecordEditRefusal.HeldInAnotherRecordNotYetSupported, $"Creating {what} is not supported yet.");

    private static string AsInteriorCell(string bareCell)
    {
        var cell = JsonNode.Parse(bareCell) as JsonObject
            ?? throw new InvalidOperationException("Expected a minted cell's document to hold a JSON object.");
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
        var isWorldspace = RecordTypeDispatch.For(release).IsWorldspace(containerType);
        if (position is not null && !isWorldspace) return MalformedPosition($"names {container}, which is not a worldspace");
        if (isWorldspace) return NotYetSupported($"a record in the worldspace {container}");

        var schemas = _schemaReflector.GetSchemas(release);
        CellPlace? place;
        try
        {
            place = RecordTypeDispatch.For(release).IsCell(containerType)
                ? repository.CellStructureOf(plugin, target.Identity)?.Place
                : null;
        }
        catch (UnreadableSourceDocumentException ex)
        {
            return WriteTargets.RefuseUnreadable(container, ex.Message);
        }

        switch (ChildRecordTypes.SlotFor(containerType, containerDocument.Body, place, recordType, schemas, release))
        {
            case ChildSlot.Open(var slot):
                return AppendChild(repository, plugin, recordType, schema, release, containerDocument, slot, place);
            case ChildSlot.Filled(var slot, var held):
                return RecordEditResult.Refused(
                    RecordEditRefusal.ChildSlotHeldByAnotherRecord,
                    $"{container} already holds {held} as its {slot}, and holds one at most. Delete it to create another.");
            case ChildSlot.Several:
                return NotYetSupported($"a {recordType} in {container}");
            default:
                return RecordEditResult.Refused(
                    RecordEditRefusal.ContainerCannotHoldType, $"{container} cannot hold a new '{recordType}' where it sits.");
        }
    }

    private RecordEditResult AppendChild(
        SourceRepository repository, PluginAddress plugin, string recordType, RecordTableSchema schema, GameRelease release,
        SourceDocument container, string slot, CellPlace? place)
    {
        if (FormKeyAllocator.Over(repository, plugin, release).Next(out var formKey) is { } refusedTarget) return refusedTarget;
        var child = JsonNode.Parse(RecordMint.BareDocument(_codec, schema, release, formKey, editorId: null)) as JsonObject
            ?? throw new InvalidOperationException($"Expected the minted {recordType}'s document to hold a JSON object.");
        var containerRoot = JsonNode.Parse(container.Body) as JsonObject
            ?? throw new InvalidOperationException($"Expected {container.FormKey}'s document to hold a JSON object.");
        PlacedCell.AsCreatedIn(child, slot, containerRoot, place, release);
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
