using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>Assertions walk the real tree, never git: git tracks files, not directories, so an
/// empty directory produces no porcelain line. The failing write is an EditorID longer than the
/// filesystem's per-component limit.</summary>
public sealed class FailedWriteDirectoryCleanupTests
{
    private static RecordEditService ServiceFor(TrackedModFixture mod) =>
        new(mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    // Exceeds the 255-byte per-component limit on every filesystem this runs on.
    private const string OverLongEditorId =
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    private static List<string> EntriesUnderSource(TrackedModFixture mod) =>
        Directory
            .EnumerateFileSystemEntries(
                Path.Combine(mod.ModFolder, SourceRecordPath.RootFor(TrackedModFixture.PluginName)),
                "*",
                SearchOption.AllDirectories)
            .Select(e => Path.GetRelativePath(mod.ModFolder, e))
            .Order(StringComparer.Ordinal)
            .ToList();

    [Fact]
    public void CreateRecord_WhoseWriteFails_LeavesNoStrayGroupFolder()
    {
        using var mod = TrackedModFixture.Tracked();
        var before = EntriesUnderSource(mod);
        Assert.DoesNotContain(before, e => e.EndsWith("Weapons", StringComparison.Ordinal));

        Assert.ThrowsAny<Exception>(() => ServiceFor(mod).CreateRecord(mod.Plugin, "weap", OverLongEditorId));

        Assert.Equal(before, EntriesUnderSource(mod));

        // The git-based assertion this suite must not rely on: it is just as empty when the stray
        // Weapons/ folder *is* there, because git has no way to report an empty directory.
        Assert.Empty(mod.GitStatus());
    }

    [Fact]
    public void CreateRecord_WhoseWriteFails_LeavesTheGroupFolderThatAlreadyExisted_AndItsRecords_Untouched()
    {
        using var mod = TrackedModFixture.Tracked();
        var before = EntriesUnderSource(mod);
        var npcsDirectory = Path.Combine(
            mod.ModFolder, SourceRecordPath.RootFor(TrackedModFixture.PluginName), "Npcs");

        // Two records plus the group's own GroupRecordData.json, which carries their order since #566.
        Assert.Equal(3, Directory.GetFiles(npcsDirectory).Length);

        Assert.ThrowsAny<Exception>(() => ServiceFor(mod).CreateRecord(mod.Plugin, "npc_", OverLongEditorId));

        Assert.True(Directory.Exists(npcsDirectory));
        Assert.Equal(3, Directory.GetFiles(npcsDirectory).Length);
        Assert.Equal(before, EntriesUnderSource(mod));
    }

    [Fact]
    public void CreateRecord_ThatSucceeds_StillMintsTheGroupFolderItNeeded()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod).CreateRecord(mod.Plugin, "weap", "AWeapon");

        Assert.True(result.Applied, result.Message);
        Assert.Contains(EntriesUnderSource(mod), e => e.EndsWith("Weapons", StringComparison.Ordinal));
    }

    // The copy gestures' ancestor chains are covered here rather than end to end: every EditorID
    // they name comes from the record being copied, so no path can be handed an over-long name.

    private sealed class TempTree : IDisposable
    {
        internal string Root { get; } = Directory.CreateTempSubdirectory("medit-mint-").FullName;

        public void Dispose()
        {
            try { Directory.Delete(Root, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
        }
    }

    [Fact]
    public void InMintedDirectory_WhenTheWriteThrows_RemovesEveryLevelItMinted_AndNothingAboveThem()
    {
        using var tree = new TempTree();
        var keeper = Path.Combine(tree.Root, "already-here.json");
        File.WriteAllText(keeper, "{}");
        var target = Path.Combine(tree.Root, "Quests", "Q", "DialogTopics");

        Assert.Throws<InvalidOperationException>(() => SourceUnitResolver.InMintedDirectory(
            target, () => throw new InvalidOperationException("the write failed")));

        Assert.False(Directory.Exists(Path.Combine(tree.Root, "Quests")));
        Assert.True(Directory.Exists(tree.Root));
        Assert.True(File.Exists(keeper));
    }

    [Fact]
    public void InMintedDirectory_WhenTheCreateItselfFailsAtTheDeepestLevel_StillRemovesTheAncestorsItMade()
    {
        using var tree = new TempTree();
        var target = Path.Combine(tree.Root, "Quests", "Q", new string('B', 300));

        Assert.ThrowsAny<Exception>(() => SourceUnitResolver.InMintedDirectory(target, () => 0));

        Assert.False(Directory.Exists(Path.Combine(tree.Root, "Quests")));
        Assert.True(Directory.Exists(tree.Root));
    }

    [Fact]
    public void InMintedDirectory_WhenTheDirectoryAlreadyExisted_LeavesItAndItsContentsAlone()
    {
        using var tree = new TempTree();
        var target = Path.Combine(tree.Root, "Npcs");
        Directory.CreateDirectory(target);
        var keeper = Path.Combine(target, "a-record.json");
        File.WriteAllText(keeper, "{}");

        Assert.Throws<InvalidOperationException>(() => SourceUnitResolver.InMintedDirectory(
            target, () => throw new InvalidOperationException("the write failed")));

        Assert.True(Directory.Exists(target));
        Assert.True(File.Exists(keeper));
    }

    [Fact]
    public void InMintedDirectory_NeverRemovesAMintedDirectoryAnotherWriterHasFilledMeanwhile()
    {
        using var tree = new TempTree();
        var target = Path.Combine(tree.Root, "Quests", "Q");
        var intruder = Path.Combine(target, "somebody-elses.json");

        Assert.Throws<InvalidOperationException>(() => SourceUnitResolver.InMintedDirectory(target, () =>
        {
            File.WriteAllText(intruder, "not mine");
            throw new InvalidOperationException("the write failed");
        }));

        Assert.True(File.Exists(intruder));
        Assert.True(Directory.Exists(Path.Combine(tree.Root, "Quests")));
    }

    [Fact]
    public void InMintedDirectory_WhenTheWriteSucceeds_KeepsTheChain_AndReturnsWhatTheWriteReturned()
    {
        using var tree = new TempTree();
        var target = Path.Combine(tree.Root, "Quests", "Q");

        var written = SourceUnitResolver.InMintedDirectory(target, () =>
        {
            File.WriteAllText(Path.Combine(target, "RecordData.json"), "{}");
            return "body";
        });

        Assert.Equal("body", written);
        Assert.True(File.Exists(Path.Combine(target, "RecordData.json")));
    }

    [Fact]
    public void MergeAdditively_WhenAFileCopyThrows_LeavesNoneOfThatFilesMintedDirectories()
    {
        using var tree = new TempTree();
        var source = Directory.CreateDirectory(Path.Combine(tree.Root, "scratch")).FullName;
        var destination = Directory.CreateDirectory(Path.Combine(tree.Root, "Worldspaces")).FullName;

        // A sub-block the destination already holds, byte-identical in both trees — the merge's own
        // convergence rule skips it, and nothing here may remove it.
        var alreadyThere = Path.Combine("W", "3, -2", "RecordData.json");
        foreach (var root in new[] { source, destination })
        {
            var path = Path.Combine(root, alreadyThere);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, "{}");
        }

        // A second sub-block, new to the destination, whose file cannot be copied.
        var doomed = Path.Combine(source, "W", "5, 1", "RecordData.json");
        Directory.CreateDirectory(Path.GetDirectoryName(doomed)!);
        File.CreateSymbolicLink(doomed, Path.Combine(tree.Root, "nothing-is-here.json"));

        Assert.ThrowsAny<Exception>(() => SourceTreeMerge.MergeAdditively(source, destination));

        Assert.False(Directory.Exists(Path.Combine(destination, "W", "5, 1")));
        Assert.True(File.Exists(Path.Combine(destination, alreadyThere)));
    }
}
