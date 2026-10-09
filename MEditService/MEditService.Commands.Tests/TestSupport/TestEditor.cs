using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Modbench's part in an edit, as the tests play it: the changes mEdit answers are saved, in the order
/// answered.</summary>
public sealed class TestEditor(EditRecordChangesHandler edits)
{
    public RecordEditResult Edit(PluginAddress plugin, string formKey, RecordEditEnvelope envelope)
    {
        var (outcome, changes) = edits.Changes(plugin, formKey, envelope);
        EditSaving.Save(
            changes.Moves.Select(move => (move.From, move.To)), changes.Deletions,
            changes.Documents.Select(document => (document.Path, document.Text)));
        return outcome;
    }
}
