using MEditService.LoadOrder;

namespace MEditService.TestSupport;

public static class TestMod
{
    public const string Name = "TestMod";

    public static PluginProvider.FromMod In(string folder) => new(Name, folder);
}
