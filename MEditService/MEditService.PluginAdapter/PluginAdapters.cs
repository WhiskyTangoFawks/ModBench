using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter;

/// <summary>The adapter's doors onto one registered plugin's own bytes, for a caller holding the
/// load order's record of where that plugin is rather than a path.</summary>
public static class PluginAdapters
{
    /// <summary>The master file names in the header of the plugin whose file name and path are named
    /// here, in header order.</summary>
    public static IReadOnlyList<string> MastersOf(
        this IPluginAdapter adapter, string pluginFileName, string pluginFilePath, GameRelease gameRelease,
        PluginStrings strings) =>
        adapter.ReadContent(new ModPath(ModKey.FromFileName(pluginFileName), pluginFilePath), gameRelease, strings)
            .Content.Masters;
}
