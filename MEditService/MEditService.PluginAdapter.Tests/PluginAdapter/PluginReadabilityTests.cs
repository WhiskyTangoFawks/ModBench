using MEditService.PluginAdapter;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

/// <summary>Whether a registered copy's file opens for the read that follows, asked of real files.
/// Another tool owns them too, so the answer is about this moment and no other.</summary>
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

    // The case the load-time check exists for: a file another process holds against readers. The
    // handle is open for the whole assertion, so the answer is ordered by the handle, not by a wait.
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

    // A directory at the plugin's path is not a plugin that reads: the probe answers false rather
    // than throwing something the caller has no branch for.
    [Fact]
    public void CanRead_ForADirectoryAtThePluginsPath_IsFalse()
    {
        var path = Path.Combine(_data.DataFolder, "Folder.esp");
        Directory.CreateDirectory(path);

        Assert.False(Adapter.CanRead(new ModPath(path)));
    }
}
