using MEditService.LoadOrder;

namespace MEditService.Commands.Tests.RealData;

/// <summary>The committed cut-down Fallout 4 plugin: real game data without the 316 MB master, so
/// the fixture is hermetic. Regenerate with the Index box's own generator when the schema or
/// curation changes.</summary>
public static class CutDownPluginFixture
{
    public const string PluginFileName = "mEditTestSubset.esm";

    public static string PluginPath =>
        Path.Combine(AppContext.BaseDirectory, "TestData", PluginFileName);

    public static readonly PluginCopyKey Plugin = new(PluginFileName, PluginOrigin.DataDirectory);
}
