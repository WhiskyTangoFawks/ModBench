using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>An external change to a fixture plugin that a validation re-derives on: a rewrite
/// with other records, or a touch that moves no record a test asserts on.</summary>
public static class PluginBinaries
{
    public static void Rewrite(string pluginPath, Action<Fallout4Mod> fill)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(Path.GetFileName(pluginPath)), Fallout4Release.Fallout4);
        fill(mod);
        mod.WriteToBinary(pluginPath);
    }

    public static void Touch(string pluginPath)
    {
        var name = Path.GetFileName(pluginPath);
        var onDisk = Fallout4Mod.CreateFromBinary(new ModPath(ModKey.FromFileName(name), pluginPath), Fallout4Release.Fallout4);
        onDisk.ModHeader.Author = $"touched {Guid.NewGuid():N}";
        onDisk.WriteToBinary(pluginPath);
    }
}
