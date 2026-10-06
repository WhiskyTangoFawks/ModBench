using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>The Create gesture's handler (ADR-0014): mints a bare record (plugins.md, Create record, story 2) and
/// writes it as a new source file under the next free FormKey of <see cref="FormKeyAllocator"/>.</summary>
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

    private RecordEditResult? RouteByContainer(PluginAddress plugin, string? container, GridPosition? position)
    {
        if (container is null) return position is null ? null : MalformedPosition("names no container");

        if (_targets.ResolveEditTarget(plugin, container, out var target) is { } unresolved) return unresolved;
        var kind = target.Identity.RecordType;
        if (position is not null && kind != "wrld") return MalformedPosition($"names {container}, which is not a worldspace");

        return kind switch
        {
            "wrld" => NotYetSupported($"a record in the worldspace {container}"),
            "cell" => NotYetSupported($"a record in the cell {container}"),
            _ => NotYetSupported($"a child of the container {container}"),
        };
    }

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
        if (RouteByContainer(plugin, container, position) is { } routed) return routed;
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
}
