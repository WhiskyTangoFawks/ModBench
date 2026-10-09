using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands.Resolution;

/// <summary>The sources one Copy gesture reads, each plugin opened once for ordering the selection
/// and for copying it. A tracked one is read through the batches, so it sees the unsaved texts and the items before it.</summary>
internal sealed class CopySources(LoadOrderResolution resolution, UnsavedBatches batches) : IDisposable
{
    private readonly Dictionary<PluginAddress, CopySource> _opened = new(PluginAddress.Comparer);

    internal CopySource Of(PluginAddress plugin)
    {
        if (!_opened.TryGetValue(plugin, out var source)) _opened[plugin] = source = resolution.SourceOf(plugin, batches);
        return source;
    }

    public void Dispose()
    {
        foreach (var source in _opened.Values) source.Dispose();
    }
}
