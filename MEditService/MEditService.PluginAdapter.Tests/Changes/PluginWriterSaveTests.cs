using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.Changes;

public sealed class PluginWriterSaveTests
{
    private static async Task RewriteAsync(string pluginPath)
    {
        using var prep = await TreeSaves.PrepareAsync(pluginPath);
        prep.Commit();
    }

    [Fact]
    public async Task Commit_OriginalPathHoldsValidPlugin()
    {
        using var data = new PluginFixtureBuilder("pw-save-original")
            .WithPlugin("TestPlugin.esp")
            .Build();

        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");

        await RewriteAsync(pluginPath);

        var reloaded = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("TestPlugin.esp"), pluginPath), Fallout4Release.Fallout4);
        Assert.Equal("TestPlugin.esp", reloaded.ModKey.FileName);
    }

    [Fact]
    public async Task Commit_LeavesTheDataFolderHoldingTheSameFiles()
    {
        using var data = new PluginFixtureBuilder("pw-save-no-tmpdir")
            .WithPlugin("TestPlugin.esp")
            .Build();
        var before = FolderEntries.Of(data.DataFolder);

        await RewriteAsync(Path.Combine(data.DataFolder, "TestPlugin.esp"));

        Assert.Equal(before, FolderEntries.Of(data.DataFolder));
    }

    [Fact]
    public async Task Commit_ThatCannotMoveTheNewBinaryIn_LeavesTheOldOne()
    {
        using var data = new PluginFixtureBuilder("pw-commit-keeps-old")
            .WithPlugin("TestPlugin.esp")
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        var before = File.ReadAllBytes(pluginPath);

        var entriesBefore = FolderEntries.Of(data.DataFolder);

        using (var prep = await TreeSaves.PrepareAsync(pluginPath))
        {
            var added = FolderEntries.TheOneAddedTo(data.DataFolder, entriesBefore);
            File.Delete(Path.Combine(added, "TestPlugin.esp"));

            Assert.ThrowsAny<IOException>(prep.Commit);
        }

        Assert.Equal(before, File.ReadAllBytes(pluginPath));
    }
}
