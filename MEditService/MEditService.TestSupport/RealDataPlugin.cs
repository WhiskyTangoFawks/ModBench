namespace MEditService.TestSupport;

/// <summary>The committed cut-down Fallout 4 plugin's name and path, for a test that reads the
/// file itself rather than an index over it.</summary>
public static class RealDataPlugin
{
    public const string PluginFileName = "mEditTestSubset.esm";

    public static string PluginPath =>
        Path.Combine(AppContext.BaseDirectory, "TestData", PluginFileName);
}
