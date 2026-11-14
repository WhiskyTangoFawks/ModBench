using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.TestSupport;

public static class PluginSources
{
    /// <summary>The plugin's binary read as the source tree it would commit, with no master to find.</summary>
    public static async Task<PluginSource> OfAsync(string pluginPath) =>
        (await TestAdapters.Mutagen().ReadSourceOfAsync(
            new RegisteredPlugin(Path.GetFileName(pluginPath), PluginOrigin.DataDirectory, pluginPath, PluginProvider.Game, Line: null, HandedStrings.Of(pluginPath)),
            EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

    /// <summary>The source mod of the plugin at <paramref name="pluginPath"/>, in the plugin's folder, made the Source
    /// repository's own way: the binary read as its tree, committed as the baseline.</summary>
    public static void Init(string pluginPath, string origin)
    {
        var source = OfAsync(pluginPath).GetAwaiter().GetResult();
        TestAdapters.Source().Init(
            Path.GetDirectoryName(pluginPath).Require(),
            [(source.Files, new DecompiledPlugin(new PluginAddress(Path.GetFileName(pluginPath), origin), source.BinarySha256))]);
    }
}
