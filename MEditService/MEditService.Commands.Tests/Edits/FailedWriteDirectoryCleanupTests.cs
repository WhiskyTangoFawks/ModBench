using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Assertions walk the real tree, never git: git tracks files, not directories, so an
/// empty directory produces no porcelain line. The failing write is an EditorID longer than the
/// filesystem's per-component limit.</summary>
public sealed class FailedWriteDirectoryCleanupTests
{
    // Exceeds the 255-byte per-component limit on every filesystem this runs on.
    private const string OverLongEditorId =
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

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

        Assert.ThrowsAny<Exception>(() => mod.CreateHandler.CreateRecord(mod.Plugin, "weap", OverLongEditorId));

        Assert.Equal(before, EntriesUnderSource(mod));

        // The git-based assertion this suite must not rely on: it is just as empty when the stray
        // Weapons/ folder *is* there, because git has no way to report an empty directory.
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

        Assert.ThrowsAny<Exception>(() => mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", OverLongEditorId));

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

    // The copy gestures' ancestor chains are covered here rather than end to end: every EditorID
    // they name comes from the record being copied, so no path can be handed an over-long name.
}
