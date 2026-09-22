using MEditService.Codec.Serialization;
using MEditService.SourceRepo;
using MEditService.TestSupport;

namespace MEditService.SourceRepo.Tests.Source;

/// <summary>Checked before touching git at all: an unguarded second Track would <c>git init</c> (a no-op),
/// fail at <c>checkout -b edit</c>, then delete the real <c>.git</c> as its own half-init.</summary>
public sealed class SourceRepositoryTrackAlreadyTrackedTests
{
    [Fact]
    public void Track_OnAnAlreadyTrackedModFolder_ThrowsAndLeavesTheExistingRepoUntouched()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-track-retrack-").FullName;
        try
        {
            var firstFiles = new[] { new TreeFile("source/Test.esp/npc_/Test.esp/000001.json", "{\"first\":true}"u8.ToArray()) };
            SourceRepository.Track(modFolder, SourcePreset.Edits, firstFiles, new TrackProvenance(null, null, new Dictionary<string, string>()));

            var gitDir = Path.Combine(modFolder, ".git");
            var firstMainSha = GitProbe.Run(gitDir, modFolder, "rev-parse", "main").Trim();

            var secondFiles = new[] { new TreeFile("source/Test.esp/npc_/Test.esp/000002.json", "{\"second\":true}"u8.ToArray()) };
            Assert.Throws<SourceAlreadyTrackedException>(() =>
                SourceRepository.Track(modFolder, SourcePreset.Edits, secondFiles, new TrackProvenance(null, null, new Dictionary<string, string>())));

            // The original repo, and specifically its original main commit, must survive intact —
            // not merely "a .git directory exists again from some other cause".
            Assert.True(SourceRepository.IsTracked(modFolder));
            Assert.Equal(firstMainSha, GitProbe.Run(gitDir, modFolder, "rev-parse", "main").Trim());
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
