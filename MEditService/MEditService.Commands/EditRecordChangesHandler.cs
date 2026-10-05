using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>The Edit gesture answered as the changes it makes to plugin source, writing nothing: the
/// document is the caller's to change and save (ADR-0001).</summary>
public sealed class EditRecordChangesHandler
{
    private readonly RecordEdit _edit;

    internal EditRecordChangesHandler(RecordEdit edit) => _edit = edit;

    /// <summary><paramref name="text"/> is the current text of the document that carries the record.</summary>
    public RecordEditChanges Changes(PluginAddress plugin, string formKey, RecordEditEnvelope envelope, string text)
    {
        var answer = SourceChanges.None;
        var outcome = _edit.Run(plugin, formKey, envelope, text, (_, _, changes) => answer = changes);
        return new RecordEditChanges(outcome, outcome.Applied ? answer : SourceChanges.None);
    }
}
