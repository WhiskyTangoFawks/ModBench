using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// ADR-0041: deleting <c>.git</c> makes the mod read as untracked again — with no residue,
/// no registry, no sweep. Source text is ordinary working-tree content once <c>.git</c> is gone;
/// nothing in this module is notified of, or reacts to, the deletion (never-assume-exclusive-
/// ownership).
/// </summary>
public sealed class SourceRepositoryUntrackTests
{
    [Fact]
    public void DeletingGit_MakesIsTrackedFalseAgain_WithSourceFilesUntouched()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-untrack-").FullName;
        try
        {
            var relativePath = Path.Combine("source", "Test.esp", "npc_", "Test.esp", "000001.json");
            var content = "{\"formKey\":\"000001:Test.esp\"}"u8.ToArray();
            SourceRepository.Track(
                modFolder, SourcePreset.Edits,
                [new PristineFile(relativePath, content)],
                new TrackProvenance(null, null, new Dictionary<string, string>()));

            var sourceFilePath = Path.Combine(modFolder, relativePath);
            Assert.True(SourceRepository.IsTracked(modFolder));
            // Positive control, checked before the deletion, through the identical File.Exists +
            // File.ReadAllBytes query the post-deletion assertions below reuse — proves the file
            // really is there (and has these exact bytes) before claiming it survives.
            Assert.True(File.Exists(sourceFilePath));
            Assert.Equal(content, File.ReadAllBytes(sourceFilePath));

            Directory.Delete(Path.Combine(modFolder, ".git"), recursive: true);

            Assert.False(SourceRepository.IsTracked(modFolder));
            Assert.True(File.Exists(sourceFilePath), "the source text is not registry-backed and must survive .git's deletion");
            Assert.Equal(content, File.ReadAllBytes(sourceFilePath));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
