using MEditService.SourceAdapter;

namespace MEditService.Commands.Tests.Edits;

public sealed class FailedWriteDirectoryCleanupTests
{
    private const string UnwritableEditorId = "Bad\0Name";

    private static List<string> EntriesUnderSource(SourceEditFixture mod) =>
        Directory
            .EnumerateFileSystemEntries(
                Path.Combine(mod.ModFolder, SourceRepository.RootFor(SourceEditFixture.PluginName)),
                "*",
                SearchOption.AllDirectories)
            .Select(e => Path.GetRelativePath(mod.ModFolder, e))
            .Order(StringComparer.Ordinal)
            .ToList();

    [Fact]
    public void CreateRecord_WhoseWriteFails_LeavesNoStrayGroupFolder()
    {
        using var mod = SourceEditFixture.Tracked();
        var before = EntriesUnderSource(mod);
        Assert.DoesNotContain(before, e => e.EndsWith("Weapons", StringComparison.Ordinal));

        Assert.ThrowsAny<Exception>(() => mod.CreateHandler.CreateRecord(mod.Plugin, "weap", UnwritableEditorId));

        Assert.Equal(before, EntriesUnderSource(mod));

        Assert.Empty(mod.GitStatus());
    }

    [Fact]
    public void CreateRecord_WhoseWriteFails_LeavesTheGroupFolderThatAlreadyExisted_AndItsRecords_Untouched()
    {
        using var mod = SourceEditFixture.Tracked();
        var before = EntriesUnderSource(mod);
        var npcsDirectory = Path.Combine(
            mod.ModFolder, SourceRepository.RootFor(SourceEditFixture.PluginName), "Npcs");

        Assert.Equal(2, Directory.GetFiles(npcsDirectory).Length);

        Assert.ThrowsAny<Exception>(() => mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", UnwritableEditorId));

        Assert.True(Directory.Exists(npcsDirectory));
        Assert.Equal(2, Directory.GetFiles(npcsDirectory).Length);
        Assert.Equal(before, EntriesUnderSource(mod));
    }

    [Fact]
    public void CreateRecord_ThatSucceeds_StillMintsTheGroupFolderItNeeded()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "weap", "AWeapon");

        Assert.True(result.Applied, result.Message);
        Assert.Contains(EntriesUnderSource(mod), e => e.EndsWith("Weapons", StringComparison.Ordinal));
    }
}
