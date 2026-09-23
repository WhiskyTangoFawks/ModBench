using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>Cleanup removes more than <c>.git</c>: the <c>.gitignore</c> and the pristine tree under
/// <c>source/</c> are written before <c>add</c>/<c>commit</c> ever run.</summary>
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
                [new TreeFile("source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray())],
                new TrackProvenance(null, null, new Dictionary<string, string>()));

            Assert.True(Directory.Exists(Path.Combine(modFolder, ".git")));
            // A successful Track still lands .gitignore and the pristine source tree —
            // the failure-path cleanup must never fire (or otherwise interfere) on
            // the happy path.
            Assert.True(File.Exists(Path.Combine(modFolder, ".gitignore")));
            Assert.True(File.Exists(Path.Combine(modFolder, "source", "Test.esp", "npc_", "Test.esp", "000001.json")));
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
            // "Poison" pristine file: its relative path names a directory segment already a plain file on
            // disk, so Directory.CreateDirectory throws partway through Track's write loop, after `git init`
            // has run: the half-done state cleanup must undo.
            File.WriteAllText(Path.Combine(modFolder, "Poison"), "not a directory");
            var poisonedFile = new TreeFile(Path.Combine("Poison", "record.json"), "{}"u8.ToArray());

            Assert.ThrowsAny<IOException>(() =>
                SourceRepository.Track(modFolder, SourcePreset.Edits, [poisonedFile], new TrackProvenance(null, null, new Dictionary<string, string>())));

            Assert.False(Directory.Exists(Path.Combine(modFolder, ".git")), "a failed Track must not leave a half-initialized repo behind");
            Assert.False(File.Exists(Path.Combine(modFolder, ".gitignore")), "a failed Track must not leave an orphaned .gitignore behind");
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void Track_FailureAfterPartialSourceWrite_LeavesNoSourceResidue()
    {
        var modFolder = NewModFolder();
        try
        {
            // The first entry writes for real, so something legitimate lands on disk before the
            // failure; the second entry's directory segment is pre-poisoned as a plain file inside
            // the source tree.
            Directory.CreateDirectory(Path.Combine(modFolder, "source", "Test.esp"));
            File.WriteAllText(Path.Combine(modFolder, "source", "Test.esp", "weap_"), "not a directory");

            IReadOnlyList<TreeFile> pristineFiles =
            [
                new TreeFile("source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()),
                new TreeFile("source/Test.esp/weap_/Test.esp/000002.json", "{}"u8.ToArray()),
            ];

            Assert.ThrowsAny<IOException>(() =>
                SourceRepository.Track(modFolder, SourcePreset.Edits, pristineFiles, new TrackProvenance(null, null, new Dictionary<string, string>())));

            Assert.False(Directory.Exists(Path.Combine(modFolder, ".git")), "a failed Track must not leave a half-initialized repo behind");
            Assert.False(File.Exists(Path.Combine(modFolder, ".gitignore")), "a failed Track must not leave an orphaned .gitignore behind");
            Assert.False(
                File.Exists(Path.Combine(modFolder, "source", "Test.esp", "npc_", "Test.esp", "000001.json")),
                "a failed Track must not leave any of its partially-written source/ tree behind");
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
