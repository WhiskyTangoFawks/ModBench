using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// #414/ADR-0041 (comment 1, #414): Track is one transaction from the caller's view — a failure
/// mid-Track leaves no half-repo. Forces a real failure partway through (a pristine file whose
/// directory collides with an existing file, so <c>Directory.CreateDirectory</c> throws) and
/// asserts nothing survives. Positive control alongside it: a normal successful Track in the same
/// file proves the absence check isn't just "Track never leaves .git behind" vacuously.
///
/// <para><b>#508:</b> the original cleanup deleted only <c>.git</c>, orphaning the <c>.gitignore</c>
/// written directly into the mod folder before the commit, and (found during triage of this same
/// ticket) the <c>pristineFiles</c> tree under <c>source/</c> for exactly the same reason — both are
/// written before <c>add</c>/<c>commit</c> ever run. <see cref="Track_FailureMidway_LeavesNoGitDirectoryBehind"/>
/// covers the former; <see cref="Track_FailureAfterPartialSourceWrite_LeavesNoSourceResidue"/> covers
/// the latter with a *partial* tree (one file already landed for real before the second one poisons
/// the write loop), proving cleanup removes what's already on disk, not just an empty folder.</para>
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
            // #508 AC2: a successful Track still lands .gitignore and the pristine source tree —
            // the cleanup added for the failure path must never fire (or otherwise interfere) on
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
            // "Poison" pristine file: its own relative path names a directory segment that is
            // already a plain file on disk in modFolder, so Directory.CreateDirectory throws
            // IOException/DirectoryNotFoundException partway through Track's write loop — after
            // `git init` has already run, exactly the half-done state the cleanup must undo.
            File.WriteAllText(Path.Combine(modFolder, "Poison"), "not a directory");
            var poisonedFile = new PristineFile(Path.Combine("Poison", "record.json"), "{}"u8.ToArray());

            Assert.ThrowsAny<IOException>(() =>
                SourceRepository.Track(modFolder, SourcePreset.Edits, [poisonedFile], new TrackProvenance(null, null, new Dictionary<string, string>())));

            Assert.False(Directory.Exists(Path.Combine(modFolder, ".git")), "a failed Track must not leave a half-initialized repo behind");
            Assert.False(File.Exists(Path.Combine(modFolder, ".gitignore")), "a failed Track must not leave an orphaned .gitignore behind (#508)");
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
            // First entry writes for real (proving something legitimate landed on disk before the
            // failure) under source/Test.esp/npc_/000001.json. Second entry's own directory segment
            // ("weap_") is pre-poisoned as a plain file *inside* the source tree itself, so
            // Directory.CreateDirectory throws mid-loop, after real pristine content already exists
            // under source/ — exactly the partial-tree residue #508 found on disk.
            Directory.CreateDirectory(Path.Combine(modFolder, "source", "Test.esp"));
            File.WriteAllText(Path.Combine(modFolder, "source", "Test.esp", "weap_"), "not a directory");

            IReadOnlyList<PristineFile> pristineFiles =
            [
                new PristineFile("source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()),
                new PristineFile("source/Test.esp/weap_/Test.esp/000002.json", "{}"u8.ToArray()),
            ];

            Assert.ThrowsAny<IOException>(() =>
                SourceRepository.Track(modFolder, SourcePreset.Edits, pristineFiles, new TrackProvenance(null, null, new Dictionary<string, string>())));

            Assert.False(Directory.Exists(Path.Combine(modFolder, ".git")), "a failed Track must not leave a half-initialized repo behind");
            Assert.False(File.Exists(Path.Combine(modFolder, ".gitignore")), "a failed Track must not leave an orphaned .gitignore behind (#508)");
            Assert.False(
                File.Exists(Path.Combine(modFolder, "source", "Test.esp", "npc_", "Test.esp", "000001.json")),
                "a failed Track must not leave any of its partially-written source/ tree behind (#508)");
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
