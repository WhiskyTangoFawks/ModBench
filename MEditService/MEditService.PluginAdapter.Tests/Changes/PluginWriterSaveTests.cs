using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.Changes;

public sealed class PluginWriterSaveTests
{
    [Fact]
    public async Task SaveAsync_Success_OriginalPathHoldsValidPlugin()
    {
        using var data = new PluginFixtureBuilder("pw-save-original")
            .WithPlugin("TestPlugin.esp")
            .Build();

        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");

        await PluginWriter.SaveAsync(pluginPath, GameRelease.Fallout4);

        var reloaded = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("TestPlugin.esp"), pluginPath), Fallout4Release.Fallout4);
        Assert.Equal("TestPlugin.esp", reloaded.ModKey.FileName);
    }

    [Fact]
    public async Task SaveAsync_Success_LeavesNoTempSubdirectory()
    {
        using var data = new PluginFixtureBuilder("pw-save-no-tmpdir")
            .WithPlugin("TestPlugin.esp")
            .Build();

        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");

        await PluginWriter.SaveAsync(pluginPath, GameRelease.Fallout4);

        var leftoverDirs = Directory.GetDirectories(data.DataFolder, ".medit_tmp_*");
        Assert.Empty(leftoverDirs);
    }

    [Fact]
    public async Task SaveAsync_KeepsNoCopyOfTheBinaryItReplaces()
    {
        using var data = new PluginFixtureBuilder("pw-save-no-copy")
            .WithPlugin("TestPlugin.esp")
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");

        await PluginWriter.SaveAsync(pluginPath, GameRelease.Fallout4);
        await PluginWriter.SaveAsync(pluginPath, GameRelease.Fallout4);

        Assert.Equal([pluginPath], Directory.GetFiles(data.DataFolder, "TestPlugin*"));
    }

    [Fact]
    public async Task Commit_ThatCannotMoveTheNewBinaryIn_LeavesTheOldOne()
    {
        using var data = new PluginFixtureBuilder("pw-commit-keeps-old")
            .WithPlugin("TestPlugin.esp")
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        var before = File.ReadAllBytes(pluginPath);
        var mod = Fallout4Mod.CreateFromBinary(
            new ModPath(ModKey.FromFileName("TestPlugin.esp"), pluginPath), Fallout4Release.Fallout4);

        using (var prep = await PluginWriter.PrepareFromModAsync(mod, pluginPath))
        {
            var tempDir = Assert.Single(Directory.GetDirectories(data.DataFolder, ".medit_tmp_*"));
            File.Delete(Path.Combine(tempDir, "TestPlugin.esp"));

            Assert.ThrowsAny<IOException>(prep.Commit);
        }

        Assert.Equal(before, File.ReadAllBytes(pluginPath));
    }
}
