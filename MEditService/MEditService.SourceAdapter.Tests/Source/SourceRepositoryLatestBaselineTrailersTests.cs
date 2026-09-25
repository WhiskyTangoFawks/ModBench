using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryLatestBaselineTrailersTests : IDisposable
{
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-baseline-trailers-").FullName;

    public void Dispose() => Directory.Delete(_modFolder, recursive: true);

    [Fact]
    public void LatestBaselineTrailersNewestFirst_ReadsBackTracksOwnTrailers()
    {
        SourceRepository.Track(_modFolder, SourcePreset.Edits, [Baseline(new BaselineTrailers("Test.esp", "1.2.3", "META0001", "BIN0001"))]);

        Assert.Equal(
            [new BaselineTrailers("Test.esp", "1.2.3", "META0001", "BIN0001")],
            SourceRepository.LatestBaselineTrailersNewestFirst(_modFolder, ["Test.esp"]));
    }

    [Fact]
    public void LatestBaselineTrailersNewestFirst_ReadsEachPluginsOwnBaseline_NewestCommitFirst()
    {
        SourceRepository.Track(
            _modFolder, SourcePreset.Edits,
            [
                Baseline(new BaselineTrailers("A.esp", "1.0", "METAA", "AAAA")),
                Baseline(new BaselineTrailers("B.esp", "2.0", "METAB", "BBBB")),
            ]);

        Assert.Equal(
            [new BaselineTrailers("B.esp", "2.0", "METAB", "BBBB"), new BaselineTrailers("A.esp", "1.0", "METAA", "AAAA")],
            SourceRepository.LatestBaselineTrailersNewestFirst(_modFolder, ["A.esp", "B.esp"]));
    }

    [Fact]
    public void LatestBaselineTrailersNewestFirst_ReadsThePluginsLatestBaseline_AfterAnUpdate()
    {
        SourceRepository.Track(
            _modFolder, SourcePreset.Edits,
            [Baseline(new BaselineTrailers("A.esp", "1.0", null, "OLD")), Baseline(new BaselineTrailers("B.esp", "1.0", null, "B"))]);

        PluginBaselines.CommitToMain(_modFolder, [Baseline(new BaselineTrailers("A.esp", "1.1", null, "NEW"))]);

        Assert.Equal(
            [new BaselineTrailers("A.esp", "1.1", null, "NEW"), new BaselineTrailers("B.esp", "1.0", null, "B")],
            SourceRepository.LatestBaselineTrailersNewestFirst(_modFolder, ["A.esp", "B.esp"]));
    }

    [Fact]
    public void LatestBaselineTrailersNewestFirst_LeavesOutAPluginMainHoldsNoBaselineOf()
    {
        SourceRepository.Track(_modFolder, SourcePreset.Edits, [Baseline(new BaselineTrailers("A.esp", "1.0", null, "AAAA"))]);

        Assert.Equal(
            [new BaselineTrailers("A.esp", "1.0", null, "AAAA")],
            SourceRepository.LatestBaselineTrailersNewestFirst(_modFolder, ["A.esp", "B.esp"]));
    }

    [Fact]
    public void LatestBaselineTrailersNewestFirst_ReadsMainEvenWithTheEditBranchCheckedOut()
    {
        SourceRepository.Track(_modFolder, SourcePreset.Edits, [Baseline(new BaselineTrailers("Test.esp", "9.9.9", null, "X"))]);
        var gitDir = Path.Combine(_modFolder, ".git");
        Assert.Equal(EditBranch.Name, GitProbe.Run(gitDir, _modFolder, "rev-parse", "--abbrev-ref", "HEAD").Trim());
        File.WriteAllText(Path.Combine(_modFolder, "source", "Test.esp", "npc_", "Test.esp", "000001.json"), "{\"edited\":true}");
        GitProbe.Run(gitDir, _modFolder, "commit", "-qam", "An edit\n\nPlugin: Test.esp\nUpstream-Version: 0.0.1");

        Assert.Equal(
            ["9.9.9"],
            SourceRepository.LatestBaselineTrailersNewestFirst(_modFolder, ["Test.esp"]).Select(baseline => baseline.UpstreamVersion));
    }

    private static (IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers) Baseline(BaselineTrailers trailers) =>
        ([new TreeFile($"source/{trailers.Plugin}/npc_/{trailers.Plugin}/000001.json", "{}"u8.ToArray())], trailers);
}
