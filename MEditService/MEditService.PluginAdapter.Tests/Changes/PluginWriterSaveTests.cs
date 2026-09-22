using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
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

        var writer = new PluginWriter(NullLogger<PluginWriter>.Instance);
        await writer.SaveAsync(pluginPath, GameRelease.Fallout4);

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

        var writer = new PluginWriter(NullLogger<PluginWriter>.Instance);
        await writer.SaveAsync(pluginPath, GameRelease.Fallout4);

        var leftoverDirs = Directory.GetDirectories(data.DataFolder, ".medit_tmp_*");
        Assert.Empty(leftoverDirs);
    }

    // ── Timestamped .bak ────────────────────────────────────────────

    [Fact]
    public async Task SaveAsync_WritesATimestampedBackupBesideThePlugin()
    {
        using var data = new PluginFixtureBuilder("pw-save-bak")
            .WithPlugin("TestPlugin.esp")
            .Build();

        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        var writer = new PluginWriter(NullLogger<PluginWriter>.Instance);

        var backupPath = await writer.SaveAsync(pluginPath, GameRelease.Fallout4);

        Assert.True(File.Exists(backupPath));
        Assert.Matches(@"TestPlugin\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}[-\d]*\.bak\.esp$", backupPath);
    }

    // Two saves at the same instant must throw, not silently overwrite the earlier backup.
    [Fact]
    public async Task SaveAsync_SameInstantTwice_ThrowsIOExceptionOnTheSecondSave()
    {
        using var data = new PluginFixtureBuilder("pw-save-collide")
            .WithPlugin("TestPlugin.esp")
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        var clock = new FakeTimeProvider(new DateTimeOffset(2024, 3, 1, 12, 0, 0, TimeSpan.Zero));
        var writer = new PluginWriter(NullLogger<PluginWriter>.Instance, clock);

        await writer.SaveAsync(pluginPath, GameRelease.Fallout4);

        await Assert.ThrowsAsync<IOException>(() => writer.SaveAsync(pluginPath, GameRelease.Fallout4));
    }

    // Two backups of one plugin in quick succession must both survive — which at one-second
    // timestamp resolution collided with the previous backup and threw, failing the save. The
    // clock is set to two distinct instants now, not raced.
    [Fact]
    public async Task SaveAsync_TwiceInQuickSuccession_KeepsBothBackups()
    {
        using var data = new PluginFixtureBuilder("pw-save-quick")
            .WithPlugin("TestPlugin.esp")
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        var clock = new FakeTimeProvider(new DateTimeOffset(2024, 3, 1, 12, 0, 0, TimeSpan.Zero));
        var writer = new PluginWriter(NullLogger<PluginWriter>.Instance, clock);

        var first = await writer.SaveAsync(pluginPath, GameRelease.Fallout4);
        clock.SetUtcNow(clock.GetUtcNow().AddTicks(1));
        var second = await writer.SaveAsync(pluginPath, GameRelease.Fallout4);

        Assert.NotEqual(first, second);
        Assert.True(File.Exists(first));
        Assert.True(File.Exists(second));
    }

    // Repeated saves prune down to the newest five, deleting the oldest as more arrive.
    [Fact]
    public async Task SaveAsync_MoreThanFiveSaves_KeepsOnlyTheNewestFiveBackups()
    {
        using var data = new PluginFixtureBuilder("pw-save-prune")
            .WithPlugin("TestPlugin.esp")
            .Build();
        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        var clock = new FakeTimeProvider(new DateTimeOffset(2020, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var writer = new PluginWriter(NullLogger<PluginWriter>.Instance, clock);

        var backups = new List<string>();
        for (var i = 0; i < 7; i++)
        {
            backups.Add(await writer.SaveAsync(pluginPath, GameRelease.Fallout4));
            clock.SetUtcNow(clock.GetUtcNow().AddSeconds(1));
        }

        var surviving = Directory.GetFiles(data.DataFolder, "TestPlugin.*.bak.esp");
        Assert.Equal(5, surviving.Length);
        Assert.False(File.Exists(backups[0]), "Oldest backup should be deleted");
        Assert.False(File.Exists(backups[1]), "Second oldest backup should be deleted");
        for (var i = 2; i < backups.Count; i++)
            Assert.True(File.Exists(backups[i]), $"Backup {i} should survive");
    }
}
