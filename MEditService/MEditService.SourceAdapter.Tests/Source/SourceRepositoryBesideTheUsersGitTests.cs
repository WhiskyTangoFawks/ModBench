using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>The user's own git runs in the same repository at any moment (ADR-0003): a commit or
/// rebase in Source Control takes <c>.git/index.lock</c>, so Modbench never holds it and never
/// needs it free.</summary>
public sealed class SourceRepositoryBesideTheUsersGitTests
{
    private const string Plugin = "Test.esp";
    private const string Document = "source/Test.esp/npc_/Test.esp/000001.json";

    private static string TrackedMod()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-users-git-").FullName;
        File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "original");
        PluginBaselines.Track(modFolder, SourcePreset.Everything, [new TreeFile(Document, "{\"a\":1}"u8.ToArray())]);
        return modFolder;
    }

    private static string IndexOf(string modFolder) => Path.Combine(modFolder, ".git", "index");

    // Same bytes, a stat the index does not hold: a plain `git status` refreshes that entry and
    // writes the index back under index.lock.
    [Fact]
    public void ReadingTheChangedTrackedFiles_LeavesAStatDirtyIndexUnwritten()
    {
        var modFolder = TrackedMod();
        try
        {
            File.SetLastWriteTimeUtc(Path.Combine(modFolder, "texture.dds"), new DateTime(2001, 1, 1, 0, 0, 0, DateTimeKind.Utc));
            var before = File.ReadAllBytes(IndexOf(modFolder));

            Assert.Empty(SourceRepository.ChangedTrackedFilesOutsideSource(modFolder));

            Assert.Equal(before, File.ReadAllBytes(IndexOf(modFolder)));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void ParkingTheWorkingTree_WhileTheUsersCommitHoldsTheIndexLock_ParksTheEditedDocument()
    {
        var modFolder = TrackedMod();
        try
        {
            File.WriteAllText(Path.Combine(modFolder, Document), "{\"a\":2}");
            var usersLock = IndexOf(modFolder) + ".lock";
            File.WriteAllText(usersLock, "");

            SourceRepository.ParkCompileSnapshot(modFolder, Plugin, atRef: null, binarySha256: "DEADBEEF");

            var parked = GitProbe.Run(
                Path.Combine(modFolder, ".git"), modFolder, "cat-file", "-p",
                $"{SourceRepository.LastCompileRef(Plugin)}:{Document}");
            Assert.Equal("{\"a\":2}", parked);
            Assert.True(File.Exists(usersLock), "the user's own lock is theirs to release");
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
