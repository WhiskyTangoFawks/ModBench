using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

/// <summary>A renumber that fails part-way leaves the working tree as it was. The faults are real
/// I/O: its write touches files and nothing else.</summary>
public sealed class RenumberRollbackTests
{
    // Free at both refs in the flat fixture's plugin, and requested rather than allocated so the
    // renumbered file's leaf name is nameable before the write.
    private static readonly FormKey NewNpcFormKey = FormKey.Factory("000F00:Fixture.esp");

    // The same, in the container fixture's plugin.
    private const string NewWorldspaceFormKey = "000F00:SourceContainer.esp";

    // A directory where the atomic write's scratch file belongs: that write fails.
    private static void Block(string path) => Directory.CreateDirectory(path + ".tmp");

    [Fact]
    public void BlockingTheRenumberedRecordsNewFile_LeavesTheSourceTreeUnchanged()
    {
        using var mod = SourceEditFixture.Tracked();
        Block(mod.SourceFileFor(NewNpcFormKey, "npc_", SourceEditFixture.NpcEditorId));

        // Taken after the block, so the restoration is measured against the tree the renumber
        // actually started from.
        var before = TreeSnapshot.Of(mod.ModFolder);
        var statusBefore = mod.GitStatus();

        var thrown = Assert.Throws<IOException>(() =>
            mod.RenumberHandler.RenumberRecord(mod.Plugin, mod.Npc.ToString(), NewNpcFormKey.ToString()));

        Assert.Equal(before, TreeSnapshot.Of(mod.ModFolder));
        Assert.Equal(statusBefore, mod.GitStatus());
        Assert.Contains("back as it was — nothing to review or revert", thrown.Message, StringComparison.Ordinal);
    }

    // A fault neither the tree nor the filesystem owns is a bug, and a bug is disclosed as itself:
    // a container whose EditorID carries a NUL has no path a rename can land on.
    [Fact]
    public void ARenumberThatFaultsUnexpectedly_RollsBack_AndRethrowsTheFaultAsItself()
    {
        using var fixture = new SourceContainerFixture();
        var worldspaceDocument = fixture.SourceFileContaining(SourceContainerFixture.WorldspaceEditorId);
        File.WriteAllText(
            worldspaceDocument,
            File.ReadAllText(worldspaceDocument).Replace(
                $"\"{SourceContainerFixture.WorldspaceEditorId}\"", "\"Fixture\\u0000World\"", StringComparison.Ordinal));
        var before = TreeSnapshot.Of(fixture.ModFolder);

        Assert.Throws<ArgumentException>(() =>
            fixture.RenumberHandler.RenumberRecord(fixture.Plugin, fixture.Worldspace.ToString(), NewWorldspaceFormKey));

        Assert.Equal(before, TreeSnapshot.Of(fixture.ModFolder));
    }

    // ---- ordering and containers ----

    [Fact]
    public void TheGroupFolder_ReturnsToItsPreActionEntries()
    {
        using var mod = SourceEditFixture.Tracked();
        var npcsFolder = Path.GetDirectoryName(mod.NpcSourceFile)
            ?? throw new InvalidOperationException($"Expected '{mod.NpcSourceFile}' to have a parent directory.");
        Block(mod.SourceFileFor(NewNpcFormKey, "npc_", SourceEditFixture.NpcEditorId));

        var entriesBefore = Directory.GetFileSystemEntries(npcsFolder)
            .Select(Path.GetFileName).Order(StringComparer.Ordinal).ToList();

        Assert.Throws<IOException>(() =>
            mod.RenumberHandler.RenumberRecord(mod.Plugin, mod.Npc.ToString(), NewNpcFormKey.ToString()));

        Assert.Equal(
            entriesBefore,
            Directory.GetFileSystemEntries(npcsFolder).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToList());
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
        var documentPath = SourceDocumentPath.Of(
            fixture.ModFolder, fixture.Plugin.Name, "wrld", newFormKey, SourceContainerFixture.WorldspaceEditorId,
            GameRelease.Fallout4);
        var directory = Path.GetDirectoryName(documentPath)
            ?? throw new InvalidOperationException($"Expected '{documentPath}' to have a parent directory.");
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
