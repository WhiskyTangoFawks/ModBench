using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>A script's Copy: the changes the Copy gesture answers for one record into one destination, which mEdit
/// writes to plugin source itself (scripts.md, Writing; ADR-0015).</summary>
public sealed class CopyRecordHandler
{
    private readonly CopyRecordChangesHandler _changes;
    private readonly ISourceAdapter _source;
    private readonly UnsavedDocuments _unsaved;
    private readonly ILogger<CopyRecordHandler> _logger;

    internal CopyRecordHandler(
        CopyRecordChangesHandler changes, ISourceAdapter source, UnsavedDocuments unsaved, ILogger<CopyRecordHandler> logger) =>
        (_changes, _source, _unsaved, _logger) = (changes, source, unsaved, logger);

    public async Task<RecordEditResult> Copy(RecordAt record, CopyMode mode, PluginAddress destination, bool replace)
    {
        var sessions = new WriteSessions(_source, _unsaved.Current);
        var selection = await _changes.CopyRecords([record], mode, [destination], replace, sessions);
        var outcome = ItemWrite.OfOne(selection, landed => landed.Outcome);
        return sessions.Written(outcome, $"Could not write the copy of {record.FormKey} into {destination.Name}", _logger);
    }
}
