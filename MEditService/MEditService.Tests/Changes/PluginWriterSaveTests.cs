using MEditService.Core.Edits;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Changes;

public sealed class PluginWriterSaveTests
{
    [Fact]
    public async Task SaveAsync_Success_OriginalPathHoldsValidPlugin()
    {
        using var data = new PluginFixtureBuilder("pw-save-original")
            .WithPlugin("TestPlugin.esp")
            .Build();

        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");

        var writer = new PluginWriter(SharedSchemaReflector.Instance, NullLogger<PluginWriter>.Instance);
        await writer.SaveAsync(pluginPath, [], GameRelease.Fallout4);

        // The original path (not a temp copy) holds a valid, re-loadable plugin after save.
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

        var writer = new PluginWriter(SharedSchemaReflector.Instance, NullLogger<PluginWriter>.Instance);
        await writer.SaveAsync(pluginPath, [], GameRelease.Fallout4);

        var leftoverDirs = Directory.GetDirectories(data.DataFolder, ".medit_tmp_*");
        Assert.Empty(leftoverDirs);
    }
}
