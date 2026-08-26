using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// #414/ADR-0041 (comment 1, #414): Track is one transaction from the caller's view — a failure
/// mid-Track leaves no half-repo. Forces a real failure partway through (a pristine file whose
/// directory collides with an existing file, so <c>Directory.CreateDirectory</c> throws) and
/// asserts nothing survives. Positive control alongside it: a normal successful Track in the same
/// file proves the absence check isn't just "Track never leaves .git behind" vacuously.
/// </summary>
public sealed class SourceRepositoryTrackCleanupTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-track-cleanup-").FullName;

    [Fact]
    public void Track_SuccessfulRun_LeavesGitPresent_PositiveControl()
    {
        var modFolder = NewModFolder();
        try
        {
            SourceRepository.Track(
                modFolder, SourcePreset.Edits,
                [new PristineFile("source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray())],
                new TrackProvenance(null, null, new Dictionary<string, string>()));

            Assert.True(Directory.Exists(Path.Combine(modFolder, ".git")));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void Track_FailureMidway_LeavesNoGitDirectoryBehind()
    {
        var modFolder = NewModFolder();
        try
        {
            // "Poison" pristine file: its own relative path names a directory segment that is
            // already a plain file on disk in modFolder, so Directory.CreateDirectory throws
            // IOException/DirectoryNotFoundException partway through Track's write loop — after
            // `git init` has already run, exactly the half-done state the cleanup must undo.
            File.WriteAllText(Path.Combine(modFolder, "Poison"), "not a directory");
            var poisonedFile = new PristineFile(Path.Combine("Poison", "record.json"), "{}"u8.ToArray());

            Assert.ThrowsAny<IOException>(() =>
                SourceRepository.Track(modFolder, SourcePreset.Edits, [poisonedFile], new TrackProvenance(null, null, new Dictionary<string, string>())));

            Assert.False(Directory.Exists(Path.Combine(modFolder, ".git")), "a failed Track must not leave a half-initialized repo behind");
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
