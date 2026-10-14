using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>A script's Delete: the changes the Delete gesture answers for one record, which mEdit writes to plugin
/// source itself (scripts.md, Writing; ADR-0015).</summary>
public sealed class DeleteRecordHandler
{
    private readonly DeleteRecordChangesHandler _changes;
    private readonly ISourceAdapter _source;
    private readonly UnsavedDocuments _unsaved;
    private readonly ILogger<DeleteRecordHandler> _logger;

    internal DeleteRecordHandler(
        DeleteRecordChangesHandler changes, ISourceAdapter source, UnsavedDocuments unsaved, ILogger<DeleteRecordHandler> logger) =>
        (_changes, _source, _unsaved, _logger) = (changes, source, unsaved, logger);

    public async Task<RecordEditResult> Delete(RecordAt record)
    {
        var sessions = new WriteSessions(_source, _unsaved.Current);
        var selection = await _changes.DeleteRecords([record], sessions);
        var outcome = ItemWrite.OfOne(selection, _ => RecordEditResult.Success());
        return sessions.Written(outcome, $"Could not write the deletion of {record.FormKey}", _logger);
    }
}
