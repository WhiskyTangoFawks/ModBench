using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>An index over the committed cut-down Fallout 4 plugin: real game data without the
/// 316 MB master, so the fixture is hermetic. `CutDownPluginGenerator` in
/// MEditService.TestSupport regenerates the file when the schema or curation changes.</summary>
public sealed class CutDownPluginFixture : IDisposable
{
    public static readonly PluginCopyKey Plugin = new(RealDataPlugin.PluginFileName, PluginOrigin.DataDirectory);

    public string InstanceRoot { get; } = Directory.CreateTempSubdirectory("medit-cutdown-instance-").FullName;

    internal IndexProjector Index { get; }

    public IRecordReads Reads => Index.RequireReads();

    public CutDownPluginFixture()
    {
        var gameDirectory = Directory.CreateDirectory(Path.Combine(InstanceRoot, "GameDir")).FullName;
        Index = Indexes.Reconciled(
            gameDirectory,
            [new LoadOrderEntry(
                RealDataPlugin.PluginFileName, RealDataPlugin.PluginPath, PluginOrigin.DataDirectory,
                Slot: 0, Enabled: true, Winning: true)],
            InstanceRoot);
    }

    public void Dispose()
    {
        Index.Dispose();
        try { Directory.Delete(InstanceRoot, recursive: true); } catch (IOException) { /* scratch, best effort */ }
    }
}
