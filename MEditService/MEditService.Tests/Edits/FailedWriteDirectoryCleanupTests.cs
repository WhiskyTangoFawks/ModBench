using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// #675 — a write that dies part-way leaves no phantom directory behind.
///
/// <para><b>Why the assertions here are entry-list assertions and never git ones.</b> Git tracks
/// files, not directories: an empty directory produces no porcelain line at all, so
/// <see cref="TrackedModFixture.GitStatus"/> is blind to exactly the debris this suite exists to
/// forbid — the author cannot see it in the Source Control panel and cannot discard it there either.
/// <see cref="EntriesUnderSource"/> therefore walks the real tree for directories <i>and</i> files.
/// <see cref="CreateRecord_WhoseWriteFails_LeavesNoStrayGroupFolder"/> asserts the git-blindness
/// directly rather than leaving it as a claim in this comment.</para>
///
/// <para><b>How a write is made to fail without a mock.</b> An EditorID longer than the filesystem's
/// per-component limit: the source file name embeds the EditorID
/// (<see cref="SourceRecordPath.For"/>), so the directory the record needs is creatable and the file
/// inside it is not. That is a real, reachable user gesture — nothing in the create path bounds an
/// EditorID's length — and it fails in exactly the window the ticket describes, after the directory
/// and before the content that would justify it.</para>
/// </summary>
public sealed class FailedWriteDirectoryCleanupTests
{
    private static RecordEditService ServiceFor(TrackedModFixture mod) =>
        new(mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    /// <summary>Long enough that "[0] &lt;this&gt; - &lt;hex6&gt;_&lt;plugin&gt;.json" exceeds the
    /// 255-byte per-component limit on every filesystem this runs on, short enough that the
    /// containing directory's own path is nowhere near one.</summary>
    private const string OverLongEditorId =
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    /// <summary>Every entry under the plugin's source tree — directories included, which is the whole
    /// point — as mod-folder-relative paths in a stable order.</summary>
    private static List<string> EntriesUnderSource(TrackedModFixture mod) =>
        Directory
            .EnumerateFileSystemEntries(
                Path.Combine(mod.ModFolder, SourceRecordPath.RootFor(TrackedModFixture.PluginName)),
                "*",
                SearchOption.AllDirectories)
            .Select(e => Path.GetRelativePath(mod.ModFolder, e))
            .Order(StringComparer.Ordinal)
            .ToList();

    /// <summary>
    /// AC1 and AC4. <c>weap</c> is a record type this fixture's plugin does not hold, so the create
    /// has to mint <c>Weapons/</c> before it can write into it — and when the write dies, that folder
    /// is the phantom entry the ticket is named for.
    /// </summary>
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

    /// <summary>
    /// AC3 — the one most likely to pass by accident. <c>npc_</c>'s group folder already exists and
    /// holds this fixture's two NPCs, so an implementation that removed its write's target directory
    /// rather than only what it minted would take two live records with it.
    /// </summary>
    [Fact]
    public void CreateRecord_WhoseWriteFails_LeavesTheGroupFolderThatAlreadyExisted_AndItsRecords_Untouched()
    {
        using var mod = TrackedModFixture.Tracked();
        var before = EntriesUnderSource(mod);
        var npcsDirectory = Path.Combine(
            mod.ModFolder, SourceRecordPath.RootFor(TrackedModFixture.PluginName), "Npcs");
        Assert.Equal(2, Directory.GetFiles(npcsDirectory).Length);

        Assert.ThrowsAny<Exception>(() => ServiceFor(mod).CreateRecord(mod.Plugin, "npc_", OverLongEditorId));

        Assert.True(Directory.Exists(npcsDirectory));
        Assert.Equal(2, Directory.GetFiles(npcsDirectory).Length);
        Assert.Equal(before, EntriesUnderSource(mod));
    }

    /// <summary>A successful create still mints the folder it needs — the negative control, so a
    /// cleanup that fired unconditionally could not pass this suite.</summary>
    [Fact]
    public void CreateRecord_ThatSucceeds_StillMintsTheGroupFolderItNeeded()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod).CreateRecord(mod.Plugin, "weap", "AWeapon");

        Assert.True(result.Applied, result.Message);
        Assert.Contains(EntriesUnderSource(mod), e => e.EndsWith("Weapons", StringComparison.Ordinal));
    }

    // ---- the mint/unmint contract itself, which the container-ancestor chains share ----
    //
    // The copy gestures' ancestor chains (RecordEditService.EnsureContainerAncestorDirectory and the
    // slot folders under it) mint several levels at once and are covered here rather than end to end:
    // every EditorID those paths name comes from the record being copied, so there is no way to hand
    // one of them an over-long name without inventing a fixture for it. What they all funnel through
    // is SourceUnitResolver.InMintedDirectory, and a multi-level chain is exactly what these exercise.

    private sealed class TempTree : IDisposable
    {
        internal string Root { get; } = Directory.CreateTempSubdirectory("medit-mint-").FullName;

        public void Dispose()
        {
            try { Directory.Delete(Root, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
        }
    }

    /// <summary>AC2's chain: three levels minted at once, none of them survives the failure, and the
    /// pre-existing root above them is not touched.</summary>
    [Fact]
    public void InMintedDirectory_WhenTheWriteThrows_RemovesEveryLevelItMinted_AndNothingAboveThem()
    {
        using var tree = new TempTree();
        var keeper = Path.Combine(tree.Root, "already-here.json");
        File.WriteAllText(keeper, "{}");
        var target = Path.Combine(tree.Root, "Quests", "[0] Q", "DialogTopics");

        Assert.Throws<InvalidOperationException>(() => SourceUnitResolver.InMintedDirectory(
            target, () => throw new InvalidOperationException("the write failed")));

        Assert.False(Directory.Exists(Path.Combine(tree.Root, "Quests")));
        Assert.True(Directory.Exists(tree.Root));
        Assert.True(File.Exists(keeper));
    }

    /// <summary>The create can itself fail part-way down — the deepest level is unreachable while its
    /// ancestors are already on disk. Those ancestors are still this call's own debris.</summary>
    [Fact]
    public void InMintedDirectory_WhenTheCreateItselfFailsAtTheDeepestLevel_StillRemovesTheAncestorsItMade()
    {
        using var tree = new TempTree();
        var target = Path.Combine(tree.Root, "Quests", "[0] Q", new string('B', 300));

        Assert.ThrowsAny<Exception>(() => SourceUnitResolver.InMintedDirectory(target, () => 0));

        Assert.False(Directory.Exists(Path.Combine(tree.Root, "Quests")));
        Assert.True(Directory.Exists(tree.Root));
    }

    /// <summary>AC3 at the unit level: a directory that was already there when the call started is
    /// never a candidate for removal, however the write ends.</summary>
    [Fact]
    public void InMintedDirectory_WhenTheDirectoryAlreadyExisted_LeavesItAndItsContentsAlone()
    {
        using var tree = new TempTree();
        var target = Path.Combine(tree.Root, "Npcs");
        Directory.CreateDirectory(target);
        var keeper = Path.Combine(target, "[0] a-record.json");
        File.WriteAllText(keeper, "{}");

        Assert.Throws<InvalidOperationException>(() => SourceUnitResolver.InMintedDirectory(
            target, () => throw new InvalidOperationException("the write failed")));

        Assert.True(Directory.Exists(target));
        Assert.True(File.Exists(keeper));
    }

    /// <summary>Root CLAUDE.md's never-assume-exclusive-ownership rule: MO2, xEdit or the author can
    /// write into a directory between its creation and the failure, and cleaning up must not take
    /// their file with it — nor the ancestors that now hold it.</summary>
    [Fact]
    public void InMintedDirectory_NeverRemovesAMintedDirectoryAnotherWriterHasFilledMeanwhile()
    {
        using var tree = new TempTree();
        var target = Path.Combine(tree.Root, "Quests", "[0] Q");
        var intruder = Path.Combine(target, "somebody-elses.json");

        Assert.Throws<InvalidOperationException>(() => SourceUnitResolver.InMintedDirectory(target, () =>
        {
            File.WriteAllText(intruder, "not mine");
            throw new InvalidOperationException("the write failed");
        }));

        Assert.True(File.Exists(intruder));
        Assert.True(Directory.Exists(Path.Combine(tree.Root, "Quests")));
    }

    /// <summary>The successful path returns the write's own result and leaves the minted chain in
    /// place — nothing here is a one-way "always clean up".</summary>
    [Fact]
    public void InMintedDirectory_WhenTheWriteSucceeds_KeepsTheChain_AndReturnsWhatTheWriteReturned()
    {
        using var tree = new TempTree();
        var target = Path.Combine(tree.Root, "Quests", "[0] Q");

        var written = SourceUnitResolver.InMintedDirectory(target, () =>
        {
            File.WriteAllText(Path.Combine(target, "RecordData.json"), "{}");
            return "body";
        });

        Assert.Equal("body", written);
        Assert.True(File.Exists(Path.Combine(target, "RecordData.json")));
    }

    /// <summary>
    /// The exterior-cell copy's own ancestor chain (AC2): <see cref="SourceTreeMerge.MergeAdditively"/>
    /// is what lands a minted <c>Worldspaces/[N] W/[N] block/[N] sub/[N] cell/</c> path into the
    /// destination tree, one file at a time. A copy that throws leaves none of the directories that
    /// file needed, and nothing the destination already had.
    ///
    /// <para>The failing copy is a dangling symlink in the scratch tree: enumeration lists it (it is
    /// not a directory), and <see cref="File.Copy(string, string)"/> then throws on a source that does
    /// not resolve — a real IO failure at exactly the per-file window, needing no mock.</para>
    /// </summary>
    [Fact]
    public void MergeAdditively_WhenAFileCopyThrows_LeavesNoneOfThatFilesMintedDirectories()
    {
        using var tree = new TempTree();
        var source = Directory.CreateDirectory(Path.Combine(tree.Root, "scratch")).FullName;
        var destination = Directory.CreateDirectory(Path.Combine(tree.Root, "Worldspaces")).FullName;

        // A sub-block the destination already holds, byte-identical in both trees — the merge's own
        // convergence rule skips it, and nothing here may remove it.
        var alreadyThere = Path.Combine("[0] W", "[0] 3, -2", "RecordData.json");
        foreach (var root in new[] { source, destination })
        {
            var path = Path.Combine(root, alreadyThere);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, "{}");
        }

        // A second sub-block, new to the destination, whose file cannot be copied.
        var doomed = Path.Combine(source, "[0] W", "[1] 5, 1", "RecordData.json");
        Directory.CreateDirectory(Path.GetDirectoryName(doomed)!);
        File.CreateSymbolicLink(doomed, Path.Combine(tree.Root, "nothing-is-here.json"));

        Assert.ThrowsAny<Exception>(() => SourceTreeMerge.MergeAdditively(source, destination));

        Assert.False(Directory.Exists(Path.Combine(destination, "[0] W", "[1] 5, 1")));
        Assert.True(File.Exists(Path.Combine(destination, alreadyThere)));
    }
}
