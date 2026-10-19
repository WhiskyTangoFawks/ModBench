using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Delete and Copy answer as tasks that complete before they return, so a test reads the
/// answer where it stands.</summary>
internal static class SyncHandlers
{
    /// <summary>What Delete answers, written nowhere.</summary>
    internal static DeleteRecordResult DeleteChangesSync(
        this DeleteRecordChangesHandler handler, IReadOnlyList<RecordAt> records) =>
        handler.DeleteRecords(records).GetAwaiter().GetResult().Value();

    /// <summary>Delete, then each landed item's changes made on disk in the order answered, as the editor makes them.</summary>
    internal static DeleteRecordResult DeleteRecordsSync(
        this DeleteRecordChangesHandler handler, IReadOnlyList<RecordAt> records)
    {
        var result = handler.DeleteChangesSync(records);
        foreach (var changes in result.Applied)
        {
            EditSaving.Save(
                changes.Moves.Select(move => (move.From, move.To)), changes.Deletions,
                changes.Documents.Select(document => (document.Path, document.Text)));
        }
        return result;
    }

    /// <summary>Create, then its changes made on disk, as the editor makes them.</summary>
    internal static RecordEditResult CreateRecordSync(
        this CreateRecordChangesHandler handler, PluginAddress plugin, string recordType, string? container = null,
        GridPosition? position = null)
    {
        var answer = handler.CreateRecord(plugin, recordType, container, position);
        if (answer.Holds(out var changes, out _))
        {
            EditSaving.Save(
                changes.Moves.Select(move => (move.From, move.To)), changes.Deletions,
                changes.Documents.Select(document => (document.Path, document.Text)));
        }
        return answer.AsResult();
    }

    /// <summary>What Copy answers, written nowhere.</summary>
    internal static CopyRecordResult CopyChangesSync(
        this CopyRecordChangesHandler handler, IReadOnlyList<RecordAt> records, CopyMode mode,
        IReadOnlyList<PluginAddress> destinations, bool replace) =>
        handler.CopyRecords(records, mode, destinations, replace).GetAwaiter().GetResult().Value();

    /// <summary>Copy, then each landed item's changes made on disk in the order answered, as the editor makes them.</summary>
    internal static CopyRecordResult CopySync(
        this CopyRecordChangesHandler handler, IReadOnlyList<RecordAt> records, CopyMode mode,
        IReadOnlyList<PluginAddress> destinations, bool replace)
    {
        var result = handler.CopyChangesSync(records, mode, destinations, replace);
        foreach (var changes in result.Applied)
        {
            EditSaving.Save(
                changes.Moves.Select(move => (move.From, move.To)), changes.Deletions,
                changes.Documents.Select(document => (document.Path, document.Text)));
        }
        return result;
    }
}
