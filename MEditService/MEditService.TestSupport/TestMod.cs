using MEditService.LoadOrder;

namespace MEditService.TestSupport;

public static class TestMod
{
    public const string Name = "TestMod";

    public static PluginProvider.FromMod In(string folder) => new(Name, folder);

    /// <summary>The mod <paramref name="plugin"/>'s origin names, held in <paramref name="folder"/>.</summary>
    public static PluginProvider.FromMod Of(PluginAddress plugin, string folder) => new(plugin.Origin, folder);
}
