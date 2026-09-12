using MEditService.Codec.Serialization;
using MEditService.SourceRepo;

namespace MEditService.Tests.Source;

/// <summary>The parked ref points at the baseline commit's own SHA (no second commit object) since
/// the tree is literally the same content at Track time (ADR-0003).</summary>
public sealed class SourceRepositoryTrackParkedRefTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-track-parkedref-").FullName;

    [Fact]
    public void Track_ParksLastCompileRef_AtTheBaselineCommit_PerPlugin()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[]
            {
                new TreeFile("source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()),
                new TreeFile("source/Other.esp/npc_/Other.esp/000002.json", "{}"u8.ToArray()),
            };
            var trailers = new TrackProvenance(
                null, null,
                new Dictionary<string, string> { ["Test.esp"] = "AAAA", ["Other.esp"] = "BBBB" });

            SourceRepository.Track(modFolder, SourcePreset.Edits, files, trailers);

            var gitDir = Path.Combine(modFolder, ".git");
            var baselineSha = GitCli.Run(gitDir, modFolder, "rev-parse", "main").Trim();

            Assert.Equal(baselineSha, GitCli.Run(gitDir, modFolder, "rev-parse", "refs/medit/last-compile/Test.esp").Trim());
            Assert.Equal(baselineSha, GitCli.Run(gitDir, modFolder, "rev-parse", "refs/medit/last-compile/Other.esp").Trim());
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void Track_WithNoPluginTrailersGiven_ParksNoRefs()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[] { new TreeFile("source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            SourceRepository.Track(modFolder, SourcePreset.Edits, files, new TrackProvenance(null, null, new Dictionary<string, string>()));

            var gitDir = Path.Combine(modFolder, ".git");
            Assert.False(GitCli.TryRun(gitDir, modFolder, out _, "rev-parse", "refs/medit/last-compile/Test.esp"));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
