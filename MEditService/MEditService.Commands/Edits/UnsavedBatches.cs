using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>One batch per mod folder over a request's unsaved texts, so an item of a selection sees what the
/// ones before it changed there.</summary>
internal sealed class UnsavedBatches(IReadOnlyList<DocumentChange> unsaved)
{
    private readonly Dictionary<string, SourceBatch> _byFolder = new(StringComparer.Ordinal);

    internal SourceBatch Over(PluginProvider.FromMod mod, GameRelease release)
    {
        if (!_byFolder.TryGetValue(mod.Folder, out var batch))
            _byFolder[mod.Folder] = batch = SourceBatch.Over(SourceRepository.Over(mod, release), unsaved);
        return batch;
    }
}
