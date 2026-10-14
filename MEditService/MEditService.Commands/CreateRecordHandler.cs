using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>A script's Create: the changes the Create gesture answers, which mEdit writes to plugin source itself
/// (scripts.md, Writing; ADR-0015).</summary>
public sealed class CreateRecordHandler
{
    private readonly CreateRecordChangesHandler _changes;
    private readonly ISourceAdapter _source;
    private readonly UnsavedDocuments _unsaved;
    private readonly ILogger<CreateRecordHandler> _logger;

    internal CreateRecordHandler(
        CreateRecordChangesHandler changes, ISourceAdapter source, UnsavedDocuments unsaved, ILogger<CreateRecordHandler> logger) =>
        (_changes, _source, _unsaved, _logger) = (changes, source, unsaved, logger);

    public RecordEditResult Create(PluginAddress plugin, string recordType, string? container = null, GridPosition? position = null)
    {
        var sessions = new WriteSessions(_source, _unsaved.Current);
        var outcome = _changes.CreateRecord(plugin, recordType, container, position, sessions).Outcome;
        return sessions.Written(outcome, $"Could not write the new {recordType}", _logger);
    }
}
