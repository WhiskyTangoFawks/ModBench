using MEditService.Commands.Edits;
using MEditService.LoadOrder;
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
    private readonly HeldWrites _held;
    private readonly ILogger<CreateRecordHandler> _logger;

    internal CreateRecordHandler(
        CreateRecordChangesHandler changes, ISourceAdapter source, UnsavedDocuments unsaved, LoadOrderHolder loadOrder, HeldWrites held,
        ILogger<CreateRecordHandler> logger) =>
        (_changes, _source, _unsaved, _loadOrder, _held, _logger) = (changes, source, unsaved, loadOrder, held, logger);

    /// <summary>Answers once the record index holds the new record.</summary>
    public async Task<Answer<RecordWritten, RecordEditRefused>> Create(
        PluginAddress plugin, string recordType, string? container, GridPosition? position, CancellationToken cancel)
    {
        var sessions = new WriteSessions(_source, _unsaved.Current);
        var outcome = _changes.CreateRecord(plugin, recordType, container, position, sessions).Outcome;
        return (await sessions.Handed(outcome, $"Could not write the new {recordType}", _loadOrder, _held, _logger, cancel)).AsWritten();
    }
}
