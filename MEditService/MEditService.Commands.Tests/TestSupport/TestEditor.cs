using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Modbench's part in an edit, as the tests play it: mEdit is given the text of the document carrying
/// the record, and the changes it answers are saved, each move in order, then each deletion and each document.</summary>
public sealed class TestEditor(EditRecordChangesHandler edits, LoadOrderHolder loadOrder)
{
    public RecordEditResult Edit(PluginAddress plugin, string formKey, RecordEditEnvelope envelope)
    {
        var (outcome, changes) = edits.Changes(plugin, formKey, envelope, TextCarrying(plugin, formKey));
        EditSaving.Save(
            changes.Moves.Select(move => (move.From, move.To)), changes.Deletions,
            changes.Documents.Select(document => (document.Path, document.Text)));
        return outcome;
    }

    // An editor opens the record's document before it edits; a record with none has no text to give. A
    // document the tree cannot read is still the file named for the record.
    private string TextCarrying(PluginAddress plugin, string formKey)
    {
        if (loadOrder.Current.ProviderOf(plugin) is not PluginProvider.FromMod mod || !SourceRepository.IsTracked(mod.Folder)) return "";
        var repository = TrackedTree.Repository(mod.Folder, plugin);
        var file = repository.Get(plugin, formKey)
            .Then(held => held is null ? SourceAnswer.Of<string?>(null) : repository.RelativePathOf(plugin, held.Identity));
        return file.Holds(out var path, out _) && path is not null ? File.ReadAllText(Path.Combine(mod.Folder, path)) : "";
    }
}
