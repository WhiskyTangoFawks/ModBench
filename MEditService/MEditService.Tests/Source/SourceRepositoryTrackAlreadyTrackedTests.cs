using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// #414: Track refuses outright on an already-tracked mod folder, checked <b>before</b> touching
/// git at all — not merely "git init happens to fail non-destructively". A second Track hitting the
/// try/cleanup block unguarded would `git init` (a no-op on an existing repo), then fail later at
/// `checkout -b edit` (the branch already exists) and delete the *real*, already-tracked
/// <c>.git</c> as if it were this call's own half-init — a genuine data-loss bug, not a hypothetical
/// one (found while designing the endpoint's error modes, #414).
/// </summary>
public sealed class SourceRepositoryTrackAlreadyTrackedTests
{
    [Fact]
    public void Track_OnAnAlreadyTrackedModFolder_ThrowsAndLeavesTheExistingRepoUntouched()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-track-retrack-").FullName;
        try
        {
            var firstFiles = new[] { new PristineFile("source/Test.esp/npc_/Test.esp/000001.json", "{\"first\":true}"u8.ToArray()) };
            SourceRepository.Track(modFolder, SourcePreset.Edits, firstFiles, new TrackProvenance(null, null, new Dictionary<string, string>()));

            var gitDir = Path.Combine(modFolder, ".git");
            var firstMainSha = GitCli.Run(gitDir, modFolder, "rev-parse", "main").Trim();

            var secondFiles = new[] { new PristineFile("source/Test.esp/npc_/Test.esp/000002.json", "{\"second\":true}"u8.ToArray()) };
            Assert.Throws<SourceAlreadyTrackedException>(() =>
                SourceRepository.Track(modFolder, SourcePreset.Edits, secondFiles, new TrackProvenance(null, null, new Dictionary<string, string>())));

            // The original repo, and specifically its original main commit, must survive intact —
            // not merely "a .git directory exists again from some other cause".
            Assert.True(SourceRepository.IsTracked(modFolder));
            Assert.Equal(firstMainSha, GitCli.Run(gitDir, modFolder, "rev-parse", "main").Trim());
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
