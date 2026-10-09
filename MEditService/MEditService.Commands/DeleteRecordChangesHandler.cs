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
    private readonly ILogger<DeleteRecordChangesHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Commands.Composition) rather than the host naming a type it cannot see.
    internal DeleteRecordChangesHandler(WriteTargets targets, LoadOrderHolder loadOrder, ILogger<DeleteRecordChangesHandler> logger) =>
        (_targets, _loadOrder, _logger) = (targets, loadOrder, logger);

    /// <summary>Each record's deletion answered as the changes it makes over <paramref name="unsaved"/>, written
    /// nowhere (ADR-0001). Each item sees the ones before it. Throws <see cref="NoLoadOrderException"/> when no
    /// load order is held (ADR-0013).</summary>
    public Task<SelectionResult<RecordAt, RecordEditRefusal, SourceChanges>> DeleteRecords(
        IReadOnlyList<RecordAt> records, IReadOnlyList<DocumentChange> unsaved)
    {
        _loadOrder.Require();
        var batches = new Dictionary<string, SourceBatch>(StringComparer.Ordinal);
        return ItemWrite.OverChanges(
            records, SameRecord.Instance,
            record => Delete(record.Plugin, record.FormKey, unsaved, batches),
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
        PluginAddress plugin, string formKey, IReadOnlyList<DocumentChange> unsaved, Dictionary<string, SourceBatch> batches)
    {
        if (_targets.ResolveEditTarget(plugin, formKey, out var target) is { } blocked) return blocked;
        var (_, identity, onDisk) = target;
        if (RefuseIfHeader(identity.RecordType) is { } headerRefusal) return headerRefusal;

        var batch = BatchOf(plugin, onDisk, unsaved, batches);
        var repository = batch.Repository;

        // Read before the removal, so what the log names is the document it took from.
        if (!repository.RelativePathOf(plugin, identity).Holds(out var relativePath, out var unread)) return unread;

        // One change either way: the owner's document without the child, or the record's own file or folder gone.
        // Every descendant's row follows from that once it is re-indexed.
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
        return SourceAnswer.Of(new RecordEditChanges(RecordEditResult.Success(), Since(before, batch.Changes)));
    }

    // One batch per mod folder, so an item sees what the ones before it changed there.
    private SourceBatch BatchOf(
        PluginAddress plugin, SourceRepository repository, IReadOnlyList<DocumentChange> unsaved, Dictionary<string, SourceBatch> batches)
    {
        if (_loadOrder.Current.Plugin(plugin)?.Provider is not PluginProvider.FromMod mod)
            throw new InvalidOperationException($"Expected {plugin.Name}, once editable, to be provided by a mod.");
        if (!batches.TryGetValue(mod.Folder, out var batch)) batches[mod.Folder] = batch = SourceBatch.Over(repository, unsaved);
        return batch;
    }

    private static SourceChanges Since(SourceChanges before, SourceChanges after) =>
        new(
            [.. after.Moves.Skip(before.Moves.Count)],
            [.. after.Deletions.Except(before.Deletions, StringComparer.Ordinal)],
            [.. after.Documents.Except(before.Documents)]);
}
