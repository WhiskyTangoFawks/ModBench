using MEditService.Codec.Serialization;
using MEditService.SourceRepo;

namespace MEditService.Tests.Source;

/// <summary>Uncommitted state through the two public doors that surface it: a rebase's own refusal,
/// and the tracked-files-outside-source query (ADR-0003).</summary>
public sealed class SourceRepositoryUncommittedStateTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-uncommitted-").FullName;

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

    // Never-assume-exclusive-ownership: a mod folder can be asked about before it is ever tracked,
    // and that must read as "nothing changed", not a throw.
    [Fact]
    public void ChangedTrackedFilesOutsideSource_ForAnUntrackedFolder_IsEmpty_NotAThrow()
    {
        var modFolder = NewModFolder();
        try
        {
            Assert.Empty(SourceRepository.ChangedTrackedFilesOutsideSource(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
