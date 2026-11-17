using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>A plugin-source document as VS Code opens or changes it: held, then read by the record index (ADR-0029).
/// Answers once the index holds it.</summary>
public sealed class PutUnsavedDocumentHandler
{
    private readonly UnsavedDocuments _unsaved;
    private readonly ISourceAdapter _source;
    private readonly LoadOrderHolder _loadOrder;
    private readonly HeldWrites _held;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal PutUnsavedDocumentHandler(UnsavedDocuments unsaved, ISourceAdapter source, LoadOrderHolder loadOrder, HeldWrites held) =>
        (_unsaved, _source, _loadOrder, _held) = (unsaved, source, loadOrder, held);

    /// <summary>Holds <paramref name="document"/>; the refusal says why not. An open replaces what is held whatever its
    /// version.</summary>
    public async Task<Answer<bool, UnsavedRefused>> Put(DocumentChange document, long version, bool opened, CancellationToken cancel)
    {
        if (_unsaved.Hold(document, version, opened, out var changed) is { } refused) return refused;
        if (changed) await _held.Hand(HandedPlugins.Naming(_source, _loadOrder.Current, [document.Path], []), cancel).ConfigureAwait(false);
        return true;
    }
}
