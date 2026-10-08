using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

/// <summary>The committed cut-down Fallout 4 plugin, loaded through the real host exactly as a
/// game-directory plugin: an empty temp game folder standing in for one, the plugin itself the
/// already-committed <see cref="RealDataPlugin"/> file.</summary>
public sealed class CutDownPluginApiFixture : IApiPluginFixture<CutDownPluginApiFixture>
{
    public string DataFolder { get; }
    public IReadOnlyList<LoadOrderEntry> Plugins { get; }
    public string InstanceRoot => _scratch.Path;

    private readonly ScratchDirectory _scratch = new("medit-cutdown-api-");

    public CutDownPluginApiFixture()
    {
        DataFolder = Directory.CreateDirectory(Path.Combine(InstanceRoot, "GameDir")).FullName;
        Plugins =
        [
            new LoadOrderEntry(
                RealDataPlugin.PluginFileName, RealDataPlugin.PluginPath, PluginOrigin.DataDirectory,
                Line: 0, Enabled: true, Winning: true),
        ];
    }

    public void Dispose() => _scratch.Dispose();

    public static CutDownPluginApiFixture Create() => new();
}
