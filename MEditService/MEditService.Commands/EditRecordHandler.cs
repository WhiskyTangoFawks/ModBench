using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands;

/// <summary>A script's Edit: the changes the Edit gesture answers, which mEdit writes to plugin source itself
/// (scripts.md, Writing).</summary>
public sealed class EditRecordHandler
{
    private readonly EditRecordChangesHandler _changes;
    private readonly ISourceAdapter _source;
    private readonly UnsavedDocuments _unsaved;
    private readonly LoadOrderHolder _loadOrder;
    private readonly HeldWrites _held;
    private readonly ILogger<EditRecordHandler> _logger;

    internal EditRecordHandler(
        EditRecordChangesHandler changes, ISourceAdapter source, UnsavedDocuments unsaved, LoadOrderHolder loadOrder, HeldWrites held,
        ILogger<EditRecordHandler> logger) =>
        (_changes, _source, _unsaved, _loadOrder, _held, _logger) = (changes, source, unsaved, loadOrder, held, logger);

    /// <summary><paramref name="copiesWithNoPluginSource"/> as <see cref="EditRecordChangesHandler.Changes"/> takes them. Answers
    /// once the record index holds the edit.</summary>
    public async Task<Answer<RecordEdited, RecordEditRefused>> Edit(
        PluginAddress plugin, string formKey, RecordEditEnvelope envelope, Func<Answer<RecordAt[], string>> copiesWithNoPluginSource,
        CancellationToken cancel)
    {
        var sessions = new WriteSessions(_source, _unsaved.Current);
        var edited = _changes.Edited(plugin, formKey, envelope, copiesWithNoPluginSource, sessions);
        var written = await sessions.Handed(edited.Outcome, $"Could not write the edit of {formKey}", _loadOrder, _held, _logger, cancel)
            .ConfigureAwait(false);
        return written.Applied
            ? new RecordEdited(written.NewFormKey, edited.LeftBehind, edited.CopiesLeftBehind, edited.CopiesUnread)
            : written.AsRefused();
    }
}
