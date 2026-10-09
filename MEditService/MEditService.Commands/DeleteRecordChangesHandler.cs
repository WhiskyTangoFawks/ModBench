using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>The Delete gesture's handler (ADR-0014): a working-tree deletion, gone at
/// Effective, still served at Head until compiled. No reference cascade (plugins.md, Delete).</summary>
public sealed class DeleteRecordChangesHandler
{
    private readonly WriteTargets _targets;
    private readonly LoadOrderHolder _loadOrder;
    private readonly UnsavedDocuments _unsaved;
    private readonly ILogger<DeleteRecordChangesHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Commands.Composition) rather than the host naming a type it cannot see.
    internal DeleteRecordChangesHandler(
        WriteTargets targets, LoadOrderHolder loadOrder, UnsavedDocuments unsaved, ILogger<DeleteRecordChangesHandler> logger) =>
        (_targets, _loadOrder, _unsaved, _logger) = (targets, loadOrder, unsaved, logger);

    /// <summary>Each record's deletion answered as the changes it makes over the held unsaved documents, written
    /// nowhere (ADR-0001). Each item sees the ones before it. Throws <see cref="NoLoadOrderException"/> when no
    /// load order is held (ADR-0013).</summary>
    public Task<SelectionResult<RecordAt, RecordEditRefusal, SourceChanges>> DeleteRecords(IReadOnlyList<RecordAt> records)
    {
        _loadOrder.Require();
        var batches = new UnsavedBatches(_unsaved.Current);
        return ItemWrite.Over(
            records, SameRecord.Instance,
            record => Delete(record.Plugin, record.FormKey, batches),
            changes => changes.Changes,
            record => $"Could not delete the source file for {record.FormKey} in {record.Plugin.Name} ({record.Plugin.Origin})",
            _logger);
    }

    // Not folded into ResolveEditTarget because Edit reaches the header deliberately.
    private static RecordEditResult? RefuseIfHeader(string recordType) =>
        recordType == PluginHeader.RecordType
            ? RecordEditResult.Refused(
                RecordEditRefusal.HeaderDeleteNotSupported,
                "The plugin header cannot be deleted — it is not an ordinary record.")
            : null;

    private SourceAnswer<RecordEditChanges> Delete(
        PluginAddress plugin, string formKey, UnsavedBatches batches)
    {
        if (_targets.ResolveEditTarget(plugin, formKey, batches, out var target) is { } blocked) return blocked;
        var (_, identity, _) = target;
        if (RefuseIfHeader(identity.RecordType) is { } headerRefusal) return headerRefusal;

        var batch = _targets.BatchOf(plugin, batches);
        var repository = batch.Repository;

        // Read before the removal, so what the log names is where it took from.
        if (!repository.RelativePathOf(plugin, identity).Holds(out var relativePath, out var unread)) return unread;

        // Every descendant's row follows from the removal once it is re-indexed.
        var before = batch.Changes;
        if (SourceTransaction.Atomically(repository, transaction => transaction.Apply(repository.ChangesToRemove(plugin, identity)))
            is { } unremoved)
            return unremoved;

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Answered the deletion of {FormKey} from {Plugin} ({Origin}) — working-tree deletion of {SourcePath}",
                formKey, plugin.Name, plugin.Origin, relativePath);
        }
        return SourceAnswer.Of(new RecordEditChanges(RecordEditResult.Success(), batch.ChangesAddedSince(before)));
    }
}
