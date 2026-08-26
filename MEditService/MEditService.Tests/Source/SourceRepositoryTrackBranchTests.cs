using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// #414/ADR-0041: Track creates and checks out the edit branch after committing the pristine
/// baseline to <c>main</c> — "Modified vs Authored is repo topology": `git diff main &lt;branch&gt;`
/// is "everything I changed", and it must be genuinely empty right after Track, not empty because
/// no distinct branch exists at all (that would make the diff command fail outright, not pass
/// trivially — see the rival case).
/// </summary>
public sealed class SourceRepositoryTrackBranchTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-track-branch-").FullName;

    [Fact]
    public void Track_ChecksOutADistinctEditBranch_WithNoDiffAgainstMain()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[] { new PristineFile("source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            SourceRepository.Track(modFolder, SourcePreset.Edits, files, new TrackProvenance(null, null, new Dictionary<string, string>()));

            var gitDir = Path.Combine(modFolder, ".git");
            var currentBranch = GitCli.Run(gitDir, modFolder, "symbolic-ref", "--short", "HEAD").Trim();

            Assert.NotEqual("main", currentBranch);
            Assert.Equal(SourceRepository.EditBranchName, currentBranch);

            // The diff-empty claim only means something once the branch is proven to be a real,
            // separate ref: `git diff main <branch>` on a branch that was never created would fail
            // with "unknown revision", not silently return empty output — so a broken Track that
            // skips branch creation could never pass this half by accident.
            var diff = GitCli.Run(gitDir, modFolder, "diff", "main", currentBranch);
            Assert.Equal(string.Empty, diff);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
