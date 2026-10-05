using MEditService.Commands.Edits;
using MEditService.LoadOrder;

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
        var plan = _edit.Plan(plugin, formKey, envelope, text);
        return new RecordEditChanges(plan.Outcome, plan.Changes);
    }
}
