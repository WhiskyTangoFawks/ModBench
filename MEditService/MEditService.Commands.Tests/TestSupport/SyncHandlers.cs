using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Delete and Copy answer as tasks that complete before they return, so a test reads the
/// answer where it stands.</summary>
internal static class SyncHandlers
{
    /// <summary>What Delete answers, over <paramref name="unsaved"/>, written nowhere.</summary>
    internal static SelectionResult<RecordAt, RecordEditRefusal, SourceChanges> DeleteChangesSync(
        this DeleteRecordChangesHandler handler, IReadOnlyList<RecordAt> records, IReadOnlyList<DocumentChange>? unsaved = null) =>
        handler.DeleteRecords(records, unsaved ?? []).GetAwaiter().GetResult();

    /// <summary>Delete, then each landed item's changes made on disk in the order answered, as the editor makes them.</summary>
    internal static SelectionResult<RecordAt, RecordEditRefusal, SourceChanges> DeleteRecordsSync(
        this DeleteRecordChangesHandler handler, IReadOnlyList<RecordAt> records, IReadOnlyList<DocumentChange>? unsaved = null)
    {
        var result = handler.DeleteChangesSync(records, unsaved);
        foreach (var changes in result.Landed.Select(landed => landed.Outcome))
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
        GridPosition? position = null, IReadOnlyList<DocumentChange>? unsaved = null)
    {
        var (outcome, changes) = handler.CreateRecord(plugin, recordType, unsaved ?? [], container, position);
        EditSaving.Save(
            changes.Moves.Select(move => (move.From, move.To)), changes.Deletions,
            changes.Documents.Select(document => (document.Path, document.Text)));
        return outcome;
    }

    /// <summary>What Copy answers, over <paramref name="unsaved"/>, written nowhere.</summary>
    internal static SelectionResult<CopyItem, RecordEditRefusal, RecordEditChanges> CopyChangesSync(
        this CopyRecordChangesHandler handler, IReadOnlyList<RecordAt> records, CopyMode mode,
        IReadOnlyList<PluginAddress> destinations, bool replace, IReadOnlyList<DocumentChange>? unsaved = null) =>
        handler.CopyRecords(records, mode, destinations, replace, unsaved ?? []).GetAwaiter().GetResult();

    /// <summary>Copy, then each landed item's changes made on disk in the order answered, as the editor makes them.</summary>
    internal static SelectionResult<CopyItem, RecordEditRefusal, RecordEditChanges> CopySync(
        this CopyRecordChangesHandler handler, IReadOnlyList<RecordAt> records, CopyMode mode,
        IReadOnlyList<PluginAddress> destinations, bool replace)
    {
        var result = handler.CopyChangesSync(records, mode, destinations, replace);
        foreach (var changes in result.Landed.Select(landed => landed.Outcome.Changes))
        {
            EditSaving.Save(
                changes.Moves.Select(move => (move.From, move.To)), changes.Deletions,
                changes.Documents.Select(document => (document.Path, document.Text)));
        }
        return result;
    }
}
