using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Modbench's part in an edit, as the tests play it: mEdit is given the text of the document carrying
/// the record, and the changes it answers are saved, each move in order and then each document.</summary>
public sealed class TestEditor(EditRecordChangesHandler edits, LoadOrderHolder loadOrder)
{
    public RecordEditResult Edit(PluginAddress plugin, string formKey, RecordEditEnvelope envelope)
    {
        var (outcome, changes) = edits.Changes(plugin, formKey, envelope, TextCarrying(plugin, formKey));
        EditSaving.Save(
            changes.Moves.Select(move => (move.From, move.To)), changes.Documents.Select(document => (document.Path, document.Text)));
        return outcome;
    }

    // An editor opens the record's document before it edits; a record with none has no text to give. A
    // document the tree cannot read is still the file named for the record.
    private string TextCarrying(PluginAddress plugin, string formKey)
    {
        if (loadOrder.Current.ProviderOf(plugin) is not PluginProvider.FromMod mod || !SourceRepository.IsTracked(mod.Folder)) return "";
        try
        {
            if (TrackedTree.DocumentFile(mod.Folder, plugin, formKey) is { } file) return File.ReadAllText(Path.Combine(mod.Folder, file));
        }
        catch (Exception ex) when (ex is UnreadableSourceDocumentException or AmbiguousSourceUnitException)
        {
        }
        return "";
    }
}
