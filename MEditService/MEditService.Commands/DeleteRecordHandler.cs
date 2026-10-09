using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>The Delete gesture's handler (ADR-0014): a working-tree deletion, gone at
/// Effective, still served at Head until compiled. No reference cascade (plugins.md, Delete).</summary>
public sealed class DeleteRecordHandler
{
    private readonly WriteTargets _targets;
    private readonly LoadOrderHolder _loadOrder;
    private readonly ILogger<DeleteRecordHandler> _logger;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Commands.Composition) rather than the host naming a type it cannot see.
    internal DeleteRecordHandler(WriteTargets targets, LoadOrderHolder loadOrder, ILogger<DeleteRecordHandler> logger) =>
        (_targets, _loadOrder, _logger) = (targets, loadOrder, logger);

    /// <summary>A record named twice is deleted once: its second delete would find nothing and be
    /// refused, for a record that is gone. Throws <see cref="NoLoadOrderException"/> when no load order
    /// is held (ADR-0013).</summary>
    public Task<SelectionResult<RecordAt, RecordEditRefusal, string?>> DeleteRecords(IReadOnlyList<RecordAt> records)
    {
        _loadOrder.Require();
        return ItemWrite.Over(
            records, SameRecord.Instance,
            record => Delete(record.Plugin, record.FormKey),
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

    private SourceAnswer<RecordEditResult> Delete(PluginAddress plugin, string formKey)
    {
        if (_targets.ResolveEditTarget(plugin, formKey, out var target) is { } blocked) return blocked;
        var (_, identity, repository) = target;
        if (RefuseIfHeader(identity.RecordType) is { } headerRefusal) return headerRefusal;

        // Read before the removal, so what the log names is the document it took from.
        if (!repository.RelativePathOf(plugin, identity).Holds(out var relativePath, out var unread)) return unread;

        // One change either way: the owner's document without the child, or the record's own file or folder gone.
        // Every descendant's row follows from that once it is re-indexed.
        if (SourceTransaction.Atomically(repository, transaction => transaction.Apply(repository.ChangesToRemove(plugin, identity)))
            is { } unremoved)
            return unremoved;

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Deleted {FormKey} from {Plugin} ({Origin}) — working-tree deletion of {SourcePath}",
                formKey, plugin.Name, plugin.Origin, relativePath);
        }
        return RecordEditResult.Success();
    }
}
