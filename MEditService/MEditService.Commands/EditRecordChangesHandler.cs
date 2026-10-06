using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>The Edit gesture answered as the changes it makes to plugin source, writing nothing: the
/// document is the caller's to change and save (ADR-0001).</summary>
public sealed class EditRecordChangesHandler
{
    private readonly RecordEdit _edit;
    private readonly LoadOrderHolder _loadOrder;

    internal EditRecordChangesHandler(RecordEdit edit, LoadOrderHolder loadOrder) => (_edit, _loadOrder) = (edit, loadOrder);

    /// <summary><paramref name="text"/> is the current text of the document that carries the record. Every path
    /// answered is absolute, since the caller opens a document by it.</summary>
    public RecordEditChanges Changes(PluginAddress plugin, string formKey, RecordEditEnvelope envelope, string text)
    {
        var (outcome, changes) = _edit.Plan(plugin, formKey, envelope, text);
        if (changes.Moves.Count == 0 && changes.Documents.Count == 0) return new RecordEditChanges(outcome, changes);

        var modFolder = SourceRepository.TrackedModOf(_loadOrder.Current, plugin)?.Folder
            ?? throw new InvalidOperationException($"Expected {plugin.Name}'s mod folder to be tracked once an edit of it planned changes.");
        return new RecordEditChanges(outcome, changes.Under(modFolder));
    }
}
