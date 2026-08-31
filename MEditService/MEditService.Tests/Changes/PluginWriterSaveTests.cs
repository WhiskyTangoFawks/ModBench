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

    // ── Timestamped .bak (ADR-0008) ────────────────────────────────────────────

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

    [Fact]
    public void CreateBackup_FileAlreadyExists_ThrowsIOException()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"pw-backup-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            var pluginPath = Path.Combine(dir, "TestPlugin.esp");
            File.WriteAllText(pluginPath, "dummy");

            var ts = "2020-01-01T00-00-00";
            PluginWriter.CreateBackup(pluginPath, ts);

            // Second call with the same timestamp must throw, not silently overwrite.
            Assert.Throws<IOException>(() => PluginWriter.CreateBackup(pluginPath, ts));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    // Two backups of one plugin in quick succession must both survive — which at one-second
    // timestamp resolution collided with the previous backup and threw, failing the save.
    [Fact]
    public void CreateBackup_TwiceInQuickSuccession_KeepsBoth()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"pw-backup-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            var pluginPath = Path.Combine(dir, "TestPlugin.esp");
            File.WriteAllText(pluginPath, "dummy");

            var first = PluginWriter.CreateBackup(pluginPath);
            var second = PluginWriter.CreateBackup(pluginPath);

            Assert.NotEqual(first, second);
            Assert.True(File.Exists(first));
            Assert.True(File.Exists(second));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void PruneOldBackups_ExcessBackups_DeletesOldestKeepsNewest()
    {
        const int maxBackups = 5;
        var dir = Path.Combine(Path.GetTempPath(), $"pw-prune-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            var pluginPath = Path.Combine(dir, "TestPlugin.esp");
            File.WriteAllText(pluginPath, "dummy");

            string[] timestamps =
            [
                "2020-01-01T00-00-01", "2020-01-01T00-00-02", "2020-01-01T00-00-03",
                "2020-01-01T00-00-04", "2020-01-01T00-00-05", "2020-01-01T00-00-06",
                "2020-01-01T00-00-07",
            ];

            var createdPaths = timestamps.Select(ts => PluginWriter.CreateBackup(pluginPath, ts)).ToList();

            var writer = new PluginWriter(NullLogger<PluginWriter>.Instance);
            writer.PruneOldBackups(pluginPath);

            var surviving = Directory.GetFiles(dir, "TestPlugin.*.bak.esp");
            Assert.Equal(maxBackups, surviving.Length);
            Assert.False(File.Exists(createdPaths[0]), "Oldest backup should be deleted");
            Assert.False(File.Exists(createdPaths[1]), "Second oldest backup should be deleted");
            for (int i = 2; i < timestamps.Length; i++)
                Assert.True(File.Exists(createdPaths[i]), $"Backup {i} should survive");
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public async Task SaveAsync_WithExcessBackups_PrunesAfterSave()
    {
        using var data = new PluginFixtureBuilder("pw-save-prune")
            .WithPlugin("TestPlugin.esp")
            .Build();

        var pluginPath = Path.Combine(data.DataFolder, "TestPlugin.esp");
        var dir = Path.GetDirectoryName(pluginPath)!;
        var name = Path.GetFileNameWithoutExtension(pluginPath);

        // Pre-create maxBackups + 1 backups; SaveAsync adds one more before pruning.
        for (int i = 1; i <= 6; i++)
            PluginWriter.CreateBackup(pluginPath, $"2020-01-0{i}T00-00-00");

        var writer = new PluginWriter(NullLogger<PluginWriter>.Instance);
        await writer.SaveAsync(pluginPath, GameRelease.Fallout4);

        var backups = Directory.GetFiles(dir, $"{name}.*.bak.esp");
        Assert.True(backups.Length <= 5, $"Expected at most 5 backups after prune, got {backups.Length}");
    }
}
