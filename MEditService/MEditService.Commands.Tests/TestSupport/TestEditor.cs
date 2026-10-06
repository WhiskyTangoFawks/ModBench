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
        foreach (var move in changes.Moves)
        {
            if (Directory.Exists(move.From)) Directory.Move(move.From, move.To);
            else File.Move(move.From, move.To);
        }
        foreach (var document in changes.Documents)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(document.Path).Require());
            File.WriteAllText(document.Path, document.Text);
        }
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
        var documents = Directory.EnumerateFiles(mod.Folder, "*.json", SearchOption.AllDirectories).ToList();
        var carrying = documents.FirstOrDefault(document => File.ReadAllText(document).Contains($"\"FormKey\": \"{formKey}\"", StringComparison.Ordinal))
            ?? documents.FirstOrDefault(document => Path.GetFileName(document).Contains(formKey.Replace(':', '_'), StringComparison.Ordinal));
        return carrying is null ? "" : File.ReadAllText(carrying);
    }
}
