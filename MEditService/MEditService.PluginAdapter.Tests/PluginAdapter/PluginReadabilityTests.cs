using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginReadabilityTests : IDisposable
{
    private const string PluginName = "Readable.esp";

    private readonly PluginFixtureData _data = new PluginFixtureBuilder("adapter-canread")
        .WithPlugin(PluginName)
        .Build();

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private string PluginPath => Path.Combine(_data.DataFolder, PluginName);

    private static RegisteredPlugin PluginAt(string path) =>
        new(Path.GetFileName(path), PluginOrigin.DataDirectory, path, PluginProvider.Game);

    public void Dispose() => _data.Dispose();

    [Fact]
    public void CanRead_ForAPluginOnDisk_IsTrue() =>
        Assert.True(Adapter.CanRead(PluginAt(PluginPath)));

    [Fact]
    public void CanRead_ForAPluginThatIsNotThere_IsFalse() =>
        Assert.False(Adapter.CanRead(PluginAt(Path.Combine(_data.DataFolder, "Absent.esp"))));

    [Fact]
    public void CanRead_ForAnEmptyFile_IsTrue()
    {
        var path = Path.Combine(_data.DataFolder, "Empty.esp");
        File.WriteAllBytes(path, []);

        Assert.True(Adapter.CanRead(PluginAt(path)));
    }

    [Fact]
    public void CanRead_WhileAnotherHandleDeniesSharing_IsFalse()
    {
        using var held = new FileStream(PluginPath, FileMode.Open, FileAccess.Read, FileShare.None);

        Assert.False(Adapter.CanRead(PluginAt(PluginPath)));
    }

    [Fact]
    public void CanRead_AfterTheHoldingHandleIsClosed_IsTrueAgain()
    {
        using (new FileStream(PluginPath, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            Assert.False(Adapter.CanRead(PluginAt(PluginPath)));
        }

        Assert.True(Adapter.CanRead(PluginAt(PluginPath)));
    }

    [Fact]
    public void CanRead_ForADirectoryAtThePluginsPath_IsFalse()
    {
        var path = Path.Combine(_data.DataFolder, "Folder.esp");
        Directory.CreateDirectory(path);

        Assert.False(Adapter.CanRead(PluginAt(path)));
    }
}
