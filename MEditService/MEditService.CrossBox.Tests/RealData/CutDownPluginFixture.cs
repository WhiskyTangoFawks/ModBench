using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.RealData;

/// <summary>The committed cut-down Fallout 4 plugin: real game data without the 316 MB master, so
/// the fixture is hermetic. Regenerate with <see cref="CutDownPluginGenerator"/> when the schema or
/// curation changes.</summary>
public sealed class CutDownPluginFixture : IDisposable
{
    public const string PluginFileName = "mEditTestSubset.esm";

    public static string PluginPath =>
        Path.Combine(AppContext.BaseDirectory, "TestData", PluginFileName);

    public static readonly PluginCopyKey Plugin = new(PluginFileName, PluginOrigin.DataDirectory);

    public string InstanceRoot { get; } = Directory.CreateTempSubdirectory("medit-cutdown-instance-").FullName;

    public IndexProjector Index { get; }

    public IRecordReads Reads => Index.RequireReads();

    public CutDownPluginFixture()
    {
        var gameDirectory = Directory.CreateDirectory(Path.Combine(InstanceRoot, "GameDir")).FullName;
        Index = Indexes.Reconciled(
            gameDirectory,
            [new LoadOrderEntry(PluginFileName, PluginPath, PluginOrigin.DataDirectory, Slot: 0, Enabled: true, Winning: true)],
            InstanceRoot);
    }

    public void Dispose()
    {
        Index.Dispose();
        try { Directory.Delete(InstanceRoot, recursive: true); } catch (IOException) { }
    }
}
