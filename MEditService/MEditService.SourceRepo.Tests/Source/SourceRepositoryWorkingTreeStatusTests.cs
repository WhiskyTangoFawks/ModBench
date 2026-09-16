using MEditService.Codec.Serialization;
using MEditService.SourceRepo;

namespace MEditService.Tests.Source;

/// <summary>Dirt detection through RebaseEditBranch's own refusal, since it names the same working-tree
/// paths WorkingTreeStatus does and is the one public door that surfaces them (ADR-0003).</summary>
public sealed class SourceRepositoryWorkingTreeStatusTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-wts-").FullName;

    [Fact]
    public void RebaseEditBranch_RefusesOverAnUnstagedEdit()
    {
        var modFolder = NewModFolder();
        try
        {
            var relativePath = Path.Combine("source", "Test.esp", "npc_", "Test.esp", "000001.json");
            var files = new[] { new TreeFile(relativePath, "{\"a\":1}"u8.ToArray()) };
            SourceRepository.Track(modFolder, SourcePreset.Edits, files, new TrackProvenance(null, null, new Dictionary<string, string>()));

            // Plain unstaged edit — never `git add`ed. A rebase refusal built off staged changes
            // only would miss this and report clean.
            File.WriteAllText(Path.Combine(modFolder, relativePath), "{\"a\":2}");

            var result = SourceRepository.RebaseEditBranch(modFolder);

            Assert.Equal(RebaseOutcome.Refused, result.Outcome);
            Assert.Contains(relativePath.Replace('\\', '/'), result.RefusalReason, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void RebaseEditBranch_IsCleanForARepoWithNoDirt()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[] { new TreeFile("source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            SourceRepository.Track(modFolder, SourcePreset.Edits, files, new TrackProvenance(null, null, new Dictionary<string, string>()));

            var result = SourceRepository.RebaseEditBranch(modFolder);

            Assert.Equal(RebaseOutcome.Clean, result.Outcome);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
