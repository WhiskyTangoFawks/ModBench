using MEditService.Core.Plugins;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.PluginAdapter;

/// <summary>The adapter's door onto one registered copy's own bytes, for a caller holding the load
/// order's record of where that copy is.</summary>
public static class PluginAdapters
{
    public static ILoadedMod Open(this IPluginAdapter adapter, RegisteredCopy copy, GameRelease release) =>
        adapter.OpenForRead(new ModPath(copy.Path), release);
}
