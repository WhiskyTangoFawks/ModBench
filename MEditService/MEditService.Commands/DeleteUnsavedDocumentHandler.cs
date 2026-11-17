using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>A plugin-source document as VS Code closes it: dropped, so the record index reads its file again (ADR-0029).
/// Answers once the index holds it.</summary>
public sealed class DeleteUnsavedDocumentHandler
{
    private readonly UnsavedDocuments _unsaved;
    private readonly ISourceAdapter _source;
    private readonly LoadOrderHolder _loadOrder;
    private readonly HeldWrites _held;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal DeleteUnsavedDocumentHandler(UnsavedDocuments unsaved, ISourceAdapter source, LoadOrderHolder loadOrder, HeldWrites held) =>
        (_unsaved, _source, _loadOrder, _held) = (unsaved, source, loadOrder, held);

    /// <summary>Drops the document at <paramref name="path"/>; the refusal says why not.</summary>
    public async Task<Answer<bool, UnsavedRefused>> Delete(string path, CancellationToken cancel)
    {
        if (_unsaved.Drop(path, out var changed) is { } refused) return refused;
        if (changed) await _held.Hand(HandedPlugins.Naming(_source, _loadOrder.Current, [path], []), cancel).ConfigureAwait(false);
        return true;
    }
}
