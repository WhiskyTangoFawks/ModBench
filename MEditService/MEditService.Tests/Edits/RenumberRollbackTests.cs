using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>A renumber that fails part-way leaves the working trees as they were (ADR-0007). The
/// faults are real I/O: its second phase writes files and nothing else.</summary>
public sealed class RenumberRollbackTests
{
    // Free at both refs in the fixture's target plugin, and requested rather than allocated so the
    // renumbered file's leaf name is nameable before the write.
    private const string NewRaceFormKey = "000F00:Target.esp";

    // The same, in the container fixture's plugin.
    private const string NewWorldspaceFormKey = "000F00:SourceContainer.esp";

    // A directory where the atomic write's scratch file belongs: that write fails, and the document
    // being rewritten stays readable, which is what makes it a referencer at all.
    private static void Block(string path) => Directory.CreateDirectory(path + ".tmp");

    // ---- the sweep ----

    [Fact]
    public void BlockingEachFileTheCascadeWrites_InTurn_LeavesEverySourceTreeUnchanged()
    {
        // Three referencing documents across three separate tracked mods, plus the renumbered
        // record's own file. If this ever drops to one the sweep has stopped proving anything.
        using (var probe = new CascadeRollbackFixture())
        {
            Assert.Equal(4, probe.CascadeWritePaths(NewRaceFormKey).Count);
        }

        for (var position = 0; position < 4; position++)
        {
            using var fixture = new CascadeRollbackFixture();
            Block(fixture.CascadeWritePaths(NewRaceFormKey)[position]);

            // Taken after the block, so the restoration is measured against the tree the cascade
            // actually started from.
            var before = fixture.Snapshots();
            var statusBefore = fixture.GitStatuses();

            var thrown = Assert.Throws<IOException>(() =>
                fixture.RenumberHandler.RenumberRecord(fixture.TargetPlugin, fixture.Race.ToString(), NewRaceFormKey));

            Assert.Equal(before, fixture.Snapshots());
            Assert.Equal(statusBefore, fixture.GitStatuses());

            // No message names a repository holding partial damage, because there is none.
            Assert.Contains("back as it was — nothing to review or revert", thrown.Message, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void ACascadeWhoseFileWriteThrows_StillLeavesEverySourceTreeUnchanged()
    {
        using var fixture = new CascadeRollbackFixture();
        Block(fixture.SourceFileOf(fixture.SecondPlugin, fixture.SecondNpc, "npc_", CascadeRollbackFixture.SecondNpcEditorId));

        var before = fixture.Snapshots();

        var thrown = Assert.Throws<IOException>(() =>
            fixture.RenumberHandler.RenumberRecord(fixture.TargetPlugin, fixture.Race.ToString()));

        Assert.Contains("back as it was", thrown.Message, StringComparison.Ordinal);
        Assert.Equal(before, fixture.Snapshots());
    }

    // ---- ordering and containers ----

    [Fact]
    public void TheGroupFolder_ReturnsToItsPreActionEntries()
    {
        using var fixture = new CascadeRollbackFixture();
        var racesFolder = Path.GetDirectoryName(
            fixture.SourceFileOf(fixture.TargetPlugin, fixture.Race, "race", CascadeRollbackFixture.RaceEditorId))!;
        Block(fixture.CascadeWritePaths(NewRaceFormKey)[0]);

        var entriesBefore = Directory.GetFileSystemEntries(racesFolder)
            .Select(Path.GetFileName).Order(StringComparer.Ordinal).ToList();

        Assert.Throws<IOException>(() =>
            fixture.RenumberHandler.RenumberRecord(fixture.TargetPlugin, fixture.Race.ToString(), NewRaceFormKey));

        Assert.Equal(
            entriesBefore,
            Directory.GetFileSystemEntries(racesFolder).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToList());
    }

    [Fact]
    public void AContainerRenumberOntoAnOccupiedPath_RefusesWithoutTouchingTheTree()
    {
        using var fixture = new SourceContainerFixture();
        // A worldspace is the one directory-per-record container: its cells and their placed
        // references travel with the directory the renumber moves.
        Occupy(RelocatedWorldspaceDirectory(fixture, NewWorldspaceFormKey));

        var before = TreeSnapshot.Of(fixture.ModFolder);
        var statusBefore = fixture.GitStatus();

        var thrown = Assert.Throws<IOException>(() =>
            fixture.RenumberHandler.RenumberRecord(fixture.Plugin, fixture.Worldspace.ToString(), NewWorldspaceFormKey));

        // The occupied check's own words, not a message the filesystem happened to produce: the
        // check is what this test is watching, not whatever Directory.Move would have said instead.
        Assert.Contains("nowhere to move to", thrown.Message, StringComparison.Ordinal);
        Assert.Equal(before, TreeSnapshot.Of(fixture.ModFolder));
        Assert.Equal(statusBefore, fixture.GitStatus());
    }

    private static void Occupy(string directory)
    {
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, "occupied.txt"), "something else is here");
    }

    // Put a placeholder at the renumber's own target and read back where the repository landed it, so
    // the collision this plants sits at the tree's own answer, not a name recomputed here.
    private static string RelocatedWorldspaceDirectory(SourceContainerFixture fixture, string newFormKey)
    {
        var repository = SourceRepository.Over(fixture.ModFolder, GameRelease.Fallout4);
        var identity = new RecordIdentity(newFormKey, "wrld", SourceContainerFixture.WorldspaceEditorId);
        repository.Put(fixture.Plugin, new SourceDocument(newFormKey, "wrld", SourceContainerFixture.WorldspaceEditorId, "{}"));
        var directory = Path.GetDirectoryName(SourceDocumentPath.Of(
            fixture.ModFolder, fixture.Plugin.Name, "wrld", newFormKey, SourceContainerFixture.WorldspaceEditorId,
            GameRelease.Fallout4))!;
        repository.Remove(fixture.Plugin, identity);
        return directory;
    }

    // ---- the oracle ----

    [Fact]
    public void TheDirectFilesystemOracleSeesAnEmptyDirectory_WhichGitStatusCallsClean()
    {
        using var fixture = new SourceContainerFixture();
        var snapshotBefore = TreeSnapshot.Of(fixture.ModFolder);
        var statusBefore = fixture.GitStatus();

        Directory.CreateDirectory(Path.Combine(fixture.SourceRoot, "Stray Record Directory"));

        Assert.Equal(statusBefore, fixture.GitStatus());
        Assert.NotEqual(snapshotBefore, TreeSnapshot.Of(fixture.ModFolder));
    }
}
