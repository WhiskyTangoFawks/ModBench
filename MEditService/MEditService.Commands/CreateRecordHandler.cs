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

    public RecordEditResult CreateRecord(PluginAddress plugin, string recordType) =>
        WriteFailure.Refused(
            () => MintRecord(plugin, recordType),
            $"Could not write the source file for the new {recordType}", _logger);

    private RecordEditResult MintRecord(PluginAddress plugin, string recordType)
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
        if (WriteTargets.RefuseIfContainerType(recordType, release) is { } containerRefusal) return containerRefusal;

        if (FormKeyAllocator.Over(repository, plugin, release).Next(out var targetFormKey)
            is { } refusedTarget) return refusedTarget;

        var body = RecordMint.BareDocument(_codec, schema, release, targetFormKey, editorId: null);

        // RefuseIfContainerType guarantees a flat record, so the repository's own layout is the whole
        // answer: no block path, and the group folder minted by the write when this type is new here.
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
