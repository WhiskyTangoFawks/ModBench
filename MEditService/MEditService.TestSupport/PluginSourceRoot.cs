namespace MEditService.TestSupport;

/// <summary>Where a plugin's source tree sits in a mod folder, as the tests that act as another tool
/// or arrange a tree by hand name it.</summary>
public static class PluginSourceRoot
{
    public static string For(string pluginFileName) => Path.Combine("plugin-source", pluginFileName);

    public static string In(string modFolder, string pluginFileName) => Path.Combine(modFolder, For(pluginFileName));
}
