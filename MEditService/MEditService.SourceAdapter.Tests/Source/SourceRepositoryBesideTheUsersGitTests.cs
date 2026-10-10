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

        var repository = TestAdapters.Source().Open(TestMod.In(modFolder), GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{modFolder}' to be tracked.");
        Assert.Empty(repository.ChangedSinceLastCommit(
            new PluginAddress(Plugin, "TestMod")).Value());

        Assert.Equal(before, File.ReadAllBytes(IndexOf(modFolder)));

        GitProbe.Run(Path.Combine(modFolder, ".git"), modFolder, "status", "--porcelain");
        Assert.NotEqual(before, File.ReadAllBytes(IndexOf(modFolder)));
    }

    [Fact]
    public void ParkingTheBinary_WhileTheUsersCommitHoldsTheIndexLock_RecordsItAndLeavesTheirLock()
    {
        using var modFolder = TrackedMod();
        var usersLock = IndexOf(modFolder) + ".lock";
        File.WriteAllText(usersLock, "");

        var repository = TestAdapters.Source().OverFolder(TestMod.In(modFolder), GameRelease.Fallout4);
        var address = new PluginAddress(Plugin, "TestMod");
        repository.WriteBinary(address, "DEADBEEF", () => { }).Value();
        Assert.Equal(["DEADBEEF"], repository.LastWrittenBinarySha256s(address).Value());
        Assert.True(File.Exists(usersLock), "the user's own lock is theirs to release");
    }
}
