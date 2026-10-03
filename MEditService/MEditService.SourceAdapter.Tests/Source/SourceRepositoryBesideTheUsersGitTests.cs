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
        PluginBaselines.Track(modFolder, SourcePreset.Everything, [new TreeFile(Document, "{\"a\":1}"u8.ToArray())]);
        return modFolder;
    }

    private static string IndexOf(string modFolder) => Path.Combine(modFolder, ".git", "index");

    [Fact]
    public void ReadingTheDirt_LeavesAStatDirtyIndexUnwritten_WhichAPlainGitStatusWouldRewriteUnderIndexLock()
    {
        using var modFolder = TrackedMod();
        File.SetLastWriteTimeUtc(Path.Combine(modFolder, Document), new DateTime(2001, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        var before = File.ReadAllBytes(IndexOf(modFolder));

        var repository = SourceRepository.Open(modFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{modFolder}' to be tracked.");
        Assert.Empty(repository.DirtOf(new PluginAddress(Plugin, "TestMod")).Documents);

        Assert.Equal(before, File.ReadAllBytes(IndexOf(modFolder)));
    }

    [Fact]
    public void ParkingTheWorkingTree_WhileTheUsersCommitHoldsTheIndexLock_ParksTheEditedDocument()
    {
        using var modFolder = TrackedMod();
        File.WriteAllText(Path.Combine(modFolder, Document), "{\"a\":2}");
        var usersLock = IndexOf(modFolder) + ".lock";
        File.WriteAllText(usersLock, "");

        SourceRepository.ParkCompileSnapshot(modFolder, Plugin, binarySha256: "DEADBEEF");

        var parked = GitProbe.Run(
            Path.Combine(modFolder, ".git"), modFolder, "cat-file", "-p",
            $"{SourceRepository.LastCompileRef(Plugin)}:{Document}");
        Assert.Equal("{\"a\":2}", parked);
        Assert.True(File.Exists(usersLock), "the user's own lock is theirs to release");
    }
}
