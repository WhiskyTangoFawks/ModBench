using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryBesideTheUsersGitTests
{
    private const string Plugin = "Test.esp";
    private const string Document = "plugin-source/Test.esp/npc_/Test.esp/000001.json";

    private static ScratchDirectory TrackedMod()
    {
        var modFolder = new ScratchDirectory("medit-users-git-");
        PluginBaselines.Track(modFolder, [new TreeFile(Document, "{\"a\":1}"u8.ToArray())]);
        return modFolder;
    }

    private static string IndexOf(string modFolder) => Path.Combine(modFolder, ".git", "index");

    [Fact]
    public void ReadingTheChanges_LeavesAStatDirtyIndexUnwritten_WhichAPlainGitStatusWouldRewriteUnderIndexLock()
    {
        using var modFolder = TrackedMod();
        File.SetLastWriteTimeUtc(Path.Combine(modFolder, Document), new DateTime(2001, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        var before = File.ReadAllBytes(IndexOf(modFolder));

        var repository = SourceRepository.Open(modFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{modFolder}' to be tracked.");
        Assert.Empty(repository.ChangedSinceLastCommit(
            new PluginAddress(Plugin, "TestMod"), SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)));

        Assert.Equal(before, File.ReadAllBytes(IndexOf(modFolder)));

        GitProbe.Run(Path.Combine(modFolder, ".git"), modFolder, "status", "--porcelain");
        Assert.NotEqual(before, File.ReadAllBytes(IndexOf(modFolder)));
    }

    [Fact]
    public void ParkingTheWorkingTree_WhileTheUsersCommitHoldsTheIndexLock_ParksTheEditedDocument()
    {
        using var modFolder = TrackedMod();
        File.WriteAllText(Path.Combine(modFolder, Document), "{\"a\":2}");
        var usersLock = IndexOf(modFolder) + ".lock";
        File.WriteAllText(usersLock, "");

        string? parked = null;
        SourceRepository.Over(modFolder, GameRelease.Fallout4).WriteBinary(
            new PluginAddress(Plugin, "TestMod"), "DEADBEEF",
            () => parked = GitProbe.Run(
                Path.Combine(modFolder, ".git"), modFolder, "cat-file", "-p",
                $"{LastWriteRecord.RefOfTheOnlyPlugin(modFolder)}:{Document}"));
        Assert.Equal("{\"a\":2}", parked);
        Assert.True(File.Exists(usersLock), "the user's own lock is theirs to release");
    }
}
