using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;
using Mutagen.Bethesda.Plugins;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Edits;

/// <summary>A renumber that fails part-way leaves the working trees as they were (ADR-0045). The
/// faults are real I/O: after ADR-0046 the cascade's second phase writes files and nothing else,
/// so a blocked path is the only thing that can fail it.</summary>
public sealed class RenumberRollbackTests
{
    // Free at both refs in the fixture's target plugin, and requested rather than allocated so the
    // renumbered file's leaf name is nameable before the write.
    private const string NewRaceFormKey = "000F00:Target.esp";

    // The same, in the container fixture's plugin.
    private const string NewWorldspaceFormKey = "000F00:ContainerFixture.esp";

    // A directory where a file belongs: the serializer's write to it fails, and nothing else about
    // the tree changes.
    private static void Block(string path)
    {
        if (File.Exists(path)) File.Delete(path);
        Directory.CreateDirectory(path);
    }

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
                ProjectingEditService.Over(fixture.Mirror)
                    .RenumberRecord(fixture.TargetPlugin, fixture.Race.ToString(), NewRaceFormKey));

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
            ProjectingEditService.Over(fixture.Mirror).RenumberRecord(fixture.TargetPlugin, fixture.Race.ToString()));

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
            ProjectingEditService.Over(fixture.Mirror)
                .RenumberRecord(fixture.TargetPlugin, fixture.Race.ToString(), NewRaceFormKey));

        Assert.Equal(
            entriesBefore,
            Directory.GetFileSystemEntries(racesFolder).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToList());
    }

    [Fact]
    public void AContainerRenumberFailingAfterRelocatingItsSubtree_PutsTheSubtreeBack()
    {
        using var fixture = new ContainerModFixture();
        // A worldspace is the fixture's one directory-per-record container: its cells and their
        // placed references travel with the directory the renumber moves.
        Occupy(RelocatedWorldspaceDirectory(fixture, NewWorldspaceFormKey));

        var before = TreeSnapshot.Of(fixture.ModFolder);
        var statusBefore = fixture.GitStatus();

        Assert.Throws<IOException>(() =>
            ProjectingEditService.Over(fixture.Mirror)
                .RenumberRecord(fixture.Plugin, fixture.Worldspace.ToString(), NewWorldspaceFormKey));

        Assert.Equal(before, TreeSnapshot.Of(fixture.ModFolder));
        Assert.Equal(statusBefore, fixture.GitStatus());
    }

    private static void Occupy(string directory)
    {
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, "occupied.txt"), "something else is here");
    }

    // Where the worldspace's own directory would land: a rename onto an occupied path fails, and
    // the subtree under it has already been moved by then.
    private static string RelocatedWorldspaceDirectory(ContainerModFixture fixture, string newFormKey)
    {
        var worldspaceDirectory = Path.GetDirectoryName(
            fixture.SourceFileContaining(ContainerModFixture.WorldspaceEditorId))!;
        return Path.Combine(
            Path.GetDirectoryName(worldspaceDirectory)!,
            SourceUnitResolver.LeafNameFor(
                FormKey.Factory(newFormKey), ContainerModFixture.WorldspaceEditorId, isDirectory: true));
    }

    // ---- what the Index says afterwards ----

    [Fact]
    public void AfterARolledBackRenumber_TheIndexAnswersTheOldIdentityAndNothingAtTheNewOne()
    {
        using var fixture = new ContainerModFixture();
        var worldspace = fixture.Worldspace.ToString();
        var cell = fixture.TopCell.ToString();
        Occupy(RelocatedWorldspaceDirectory(fixture, NewWorldspaceFormKey));

        Assert.Throws<IOException>(() =>
            ProjectingEditService.Over(fixture.Mirror)
                .RenumberRecord(fixture.Plugin, worldspace, NewWorldspaceFormKey));

        // The projector re-read the restored tree, so the old identity is what answers: the
        // rollback put the files back and nothing else had to unwind an index.
        var reads = fixture.Mirror.Projected();
        Assert.NotNull(reads.GetDocument(worldspace, fixture.Plugin));
        Assert.Null(reads.GetDocument(NewWorldspaceFormKey, fixture.Plugin));
        Assert.Equal(worldspace, reads.GetCellLocation(fixture.Plugin, cell)?.ParentWorldspace);
        Assert.Equal(
            fixture.Quest.ToString(),
            reads.GetContainerParent(fixture.Plugin, fixture.DialogTopic.ToString())?.ParentFormKey);
    }

    [Fact]
    public void AfterARolledBackCascade_TheReferenceGraphStillNamesTheOldFormKey()
    {
        using var fixture = new CascadeRollbackFixture();
        var race = fixture.Race.ToString();
        // The renumbered record's own destination, which no document occupies yet: blocking a
        // referencer's file would remove that referencer from the tree, and the projector would be
        // right to drop it.
        Block(fixture.RenumberedRacePath(NewRaceFormKey));

        Assert.Throws<IOException>(() =>
            ProjectingEditService.Over(fixture.Mirror)
                .RenumberRecord(fixture.TargetPlugin, race, NewRaceFormKey));

        var reads = fixture.Mirror.Projected();
        Assert.Equal(3, reads.GetReferencedBy(race).Select(r => r.FormKey).Distinct().Count());

        // And nothing at the identity the renumber was reaching for.
        Assert.Null(reads.GetDocument(NewRaceFormKey, fixture.TargetPlugin));
        Assert.Empty(reads.GetReferencedBy(NewRaceFormKey));
    }

    // ---- the oracle ----

    [Fact]
    public void TheDirectFilesystemOracleSeesAnEmptyDirectory_WhichGitStatusCallsClean()
    {
        using var fixture = new ContainerModFixture();
        var snapshotBefore = TreeSnapshot.Of(fixture.ModFolder);
        var statusBefore = fixture.GitStatus();

        Directory.CreateDirectory(Path.Combine(fixture.SourceRoot, "Stray Record Directory"));

        Assert.Equal(statusBefore, fixture.GitStatus());
        Assert.NotEqual(snapshotBefore, TreeSnapshot.Of(fixture.ModFolder));
    }
}
