using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.TestSupport;

/// <summary>Rewrites a fixture plugin so its bytes differ while its record set does not: the
/// external change a binary watch settles on, without moving any record a test asserts on.</summary>
public static class PluginBinaries
{
    public static void Touch(string pluginPath)
    {
        var name = Path.GetFileName(pluginPath);
        var onDisk = Fallout4Mod.CreateFromBinary(new ModPath(ModKey.FromFileName(name), pluginPath), Fallout4Release.Fallout4);
        onDisk.ModHeader.Author = $"touched {Guid.NewGuid():N}";
        onDisk.WriteToBinary(pluginPath);
    }
}
