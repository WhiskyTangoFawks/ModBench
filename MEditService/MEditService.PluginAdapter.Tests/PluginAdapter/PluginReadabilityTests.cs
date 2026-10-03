using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginReadabilityTests : IDisposable
{
    private const string PluginName = "Readable.esp";

    private readonly PluginFixtureData _data = new PluginFixtureBuilder("adapter-canread")
        .WithPlugin(PluginName)
        .Build();

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private string PluginPath => Path.Combine(_data.DataFolder, PluginName);

    public void Dispose() => _data.Dispose();

    [Fact]
    public void CanRead_ForAPluginOnDisk_IsTrue() =>
        Assert.True(Adapter.CanRead(new ModPath(PluginPath)));

    [Fact]
    public void CanRead_ForAPluginThatIsNotThere_IsFalse() =>
        Assert.False(Adapter.CanRead(new ModPath(Path.Combine(_data.DataFolder, "Absent.esp"))));

    [Fact]
    public void CanRead_ForAnEmptyFile_IsTrue()
    {
        var path = Path.Combine(_data.DataFolder, "Empty.esp");
        File.WriteAllBytes(path, []);

        Assert.True(Adapter.CanRead(new ModPath(path)));
    }

    [Fact]
    public void CanRead_WhileAnotherHandleDeniesSharing_IsFalse()
    {
        using var held = new FileStream(PluginPath, FileMode.Open, FileAccess.Read, FileShare.None);

        Assert.False(Adapter.CanRead(new ModPath(PluginPath)));
    }

    [Fact]
    public void CanRead_AfterTheHoldingHandleIsClosed_IsTrueAgain()
    {
        using (new FileStream(PluginPath, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            Assert.False(Adapter.CanRead(new ModPath(PluginPath)));
        }

        Assert.True(Adapter.CanRead(new ModPath(PluginPath)));
    }

    [Fact]
    public void CanRead_ForADirectoryAtThePluginsPath_IsFalse()
    {
        var path = Path.Combine(_data.DataFolder, "Folder.esp");
        Directory.CreateDirectory(path);

        Assert.False(Adapter.CanRead(new ModPath(path)));
    }
}
