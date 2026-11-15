using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>A script's Create: the changes the Create gesture answers, which mEdit writes to plugin source itself
/// (scripts.md, Writing).</summary>
public sealed class CreateRecordHandler
{
    private readonly CreateRecordChangesHandler _changes;
    private readonly ISourceAdapter _source;
    private readonly UnsavedDocuments _unsaved;
    private readonly LoadOrderHolder _loadOrder;
    private readonly IQueries _index;
    private readonly ILogger<CreateRecordHandler> _logger;

    internal CreateRecordHandler(
        CreateRecordChangesHandler changes, ISourceAdapter source, UnsavedDocuments unsaved, LoadOrderHolder loadOrder, IQueries index,
        ILogger<CreateRecordHandler> logger) =>
        (_changes, _source, _unsaved, _loadOrder, _index, _logger) = (changes, source, unsaved, loadOrder, index, logger);

    /// <summary>Answers once the record index holds the new record; <paramref name="cancel"/> stops the wait, not the write.</summary>
    public async Task<Answer<RecordWritten, RecordEditRefused>> Create(
        PluginAddress plugin, string recordType, string? container, GridPosition? position, CancellationToken cancel)
    {
        var sessions = new WriteSessions(_source, _unsaved.Current);
        var outcome = _changes.CreateRecord(plugin, recordType, container, position, sessions).Outcome;
        return (await sessions.Handed(outcome, $"Could not write the new {recordType}", _loadOrder, _index, _logger, cancel)).AsWritten();
    }
}
