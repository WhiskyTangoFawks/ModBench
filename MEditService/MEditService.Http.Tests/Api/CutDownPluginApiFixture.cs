using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Api;

/// <summary>The committed cut-down Fallout 4 plugin, loaded through the real host exactly as a
/// game-directory copy: an empty temp game folder standing in for one, the plugin itself the
/// already-committed <see cref="RealDataPlugin"/> file.</summary>
public sealed class CutDownPluginApiFixture : IApiPluginFixture<CutDownPluginApiFixture>
{
    public string DataFolder { get; }
    public IReadOnlyList<LoadOrderEntry> Plugins { get; }
    public string InstanceRoot { get; }

    public CutDownPluginApiFixture()
    {
        InstanceRoot = Directory.CreateTempSubdirectory("medit-cutdown-api-").FullName;
        DataFolder = Directory.CreateDirectory(Path.Combine(InstanceRoot, "GameDir")).FullName;
        Plugins =
        [
            new LoadOrderEntry(
                RealDataPlugin.PluginFileName, RealDataPlugin.PluginPath, PluginOrigin.DataDirectory,
                Slot: 0, Enabled: true, Winning: true),
        ];
    }

    public void Dispose()
    {
        try { Directory.Delete(InstanceRoot, recursive: true); } catch (IOException) { /* scratch, best-effort */ }
    }

    public static CutDownPluginApiFixture Create() => new();
}
