using MEditService.Core.Serialization;
using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary><c>git diff main &lt;branch&gt;</c> must be genuinely empty right after Track, not
/// empty because no distinct branch exists (ADR-0007: Modified vs Authored is repo topology).</summary>
public sealed class SourceRepositoryTrackBranchTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-track-branch-").FullName;

    [Fact]
    public void Track_ChecksOutADistinctEditBranch_WithNoDiffAgainstMain()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[] { new TreeFile("source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            SourceRepository.Track(modFolder, SourcePreset.Edits, files, new TrackProvenance(null, null, new Dictionary<string, string>()));

            var gitDir = Path.Combine(modFolder, ".git");
            var currentBranch = GitCli.Run(gitDir, modFolder, "symbolic-ref", "--short", "HEAD").Trim();

            Assert.NotEqual("main", currentBranch);
            Assert.Equal(SourceRepository.EditBranchName, currentBranch);

            // The diff-empty claim only means something once the branch is a real, separate ref: `git diff` on
            // a branch never created fails with "unknown revision" rather than returning empty.
            var diff = GitCli.Run(gitDir, modFolder, "diff", "main", currentBranch);
            Assert.Equal(string.Empty, diff);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
