using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>A script's Delete: the changes the Delete gesture answers for one record, which mEdit writes to plugin
/// source itself (scripts.md, Writing).</summary>
public sealed class DeleteRecordHandler
{
    private readonly DeleteRecordChangesHandler _changes;
    private readonly ISourceAdapter _source;
    private readonly UnsavedDocuments _unsaved;
    private readonly LoadOrderHolder _loadOrder;
    private readonly IQueries _index;
    private readonly ILogger<DeleteRecordHandler> _logger;

    internal DeleteRecordHandler(
        DeleteRecordChangesHandler changes, ISourceAdapter source, UnsavedDocuments unsaved, LoadOrderHolder loadOrder, IQueries index,
        ILogger<DeleteRecordHandler> logger) =>
        (_changes, _source, _unsaved, _loadOrder, _index, _logger) = (changes, source, unsaved, loadOrder, index, logger);

    /// <summary>Answers once the record index holds the deletion; <paramref name="cancel"/> stops the wait, not the write.</summary>
    public async Task<RecordEditResult> Delete(RecordAt record, CancellationToken cancel)
    {
        var sessions = new WriteSessions(_source, _unsaved.Current);
        var selection = await _changes.DeleteRecords([record], sessions);
        var outcome = ItemWrite.OfOne(selection, _ => RecordEditResult.Success());
        return await sessions.Handed(outcome, $"Could not write the deletion of {record.FormKey}", _loadOrder, _index, _logger, cancel);
    }
}
