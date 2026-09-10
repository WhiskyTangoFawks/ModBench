using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Commands;

/// <summary>The Create gesture's handler (ADR-0046 invariant 3): mints a bare record (ruling 4) and
/// writes it as a new source file. FormKey allocation is <see cref="WriteTargets"/>'s alone.</summary>
public sealed class CreateRecordHandler
{
    private readonly WriteTargets _targets;
    private readonly LoadOrderHolder _loadOrder;
    private readonly RecordTextCodec _codec;
    private readonly SchemaReflector _schemaReflector;
    private readonly ILogger<CreateRecordHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Core.Composition) rather than the host naming a type it cannot see.
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

    /// <summary>The FormKey is <paramref name="requestedFormKey"/> (xEdit's typed-FormID path) or the next
    /// free local ID, collision-checked at both refs so an uncompiled create or a working-tree-deleted
    /// record is never handed out twice.</summary>
    public RecordEditResult CreateRecord(PluginKey plugin, string recordType, string? editorId, string? requestedFormKey = null)
    {
        if (_targets.RefuseIfBlocked(plugin, out _, out var repository) is { } blocked) return blocked;

        var release = _loadOrder.Current.GameRelease;
        var schemas = _schemaReflector.GetSchemas(release);
        if (recordType == PluginHeader.RecordType || !schemas.TryGetValue(recordType, out var schema))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.RecordTypeNotFound, $"'{recordType}' is not a creatable record type.");
        }
        if (WriteTargets.RefuseIfContainerType(recordType, release) is { } containerRefusal) return containerRefusal;

        if (_targets.ResolveTargetFormKey(repository, plugin, requestedFormKey, out var targetFormKey)
            is { } refusedTarget) return refusedTarget;

        var record = RecordMint.Bare(
            _codec, schema, release, targetFormKey, string.IsNullOrWhiteSpace(editorId) ? null : editorId, partialForm: false);

        // RefuseIfContainerType guarantees a flat record, so the repository's own layout is the whole
        // answer: no block path, and the group folder minted by the write when this type is new here.
        repository.Put(
            plugin, new SourceDocument(targetFormKey, recordType, record.EditorID, _codec.SerializeToText(record, release)));

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Created {RecordType} {FormKey} in {Plugin} ({Origin}) — new working-tree source document",
                recordType, targetFormKey, plugin.Name, plugin.Origin);
        }
        return RecordEditResult.Success(targetFormKey);
    }
}
