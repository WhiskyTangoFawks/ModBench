using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryLatestBaselineTrailersTests : IDisposable
{
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-baseline-trailers-").FullName;

    public void Dispose() => Directory.Delete(_modFolder, recursive: true);

    [Fact]
    public void LatestBaselineTrailers_ReadsBackTracksOwnTrailers()
    {
        SourceRepository.Track(_modFolder, SourcePreset.Edits, [Baseline(new BaselineTrailers("Test.esp", "1.2.3", "META0001", "BIN0001"))]);

        Assert.Equal(
            new BaselineTrailers("Test.esp", "1.2.3", "META0001", "BIN0001"),
            SourceRepository.LatestBaselineTrailers(_modFolder, "Test.esp"));
    }

    [Fact]
    public void LatestBaselineTrailers_ReadsEachPluginsOwnBaseline_WhenTwoShareTheRepository()
    {
        SourceRepository.Track(
            _modFolder, SourcePreset.Edits,
            [
                Baseline(new BaselineTrailers("A.esp", "1.0", "METAA", "AAAA")),
                Baseline(new BaselineTrailers("B.esp", "2.0", "METAB", "BBBB")),
            ]);

        Assert.Equal(new BaselineTrailers("A.esp", "1.0", "METAA", "AAAA"), SourceRepository.LatestBaselineTrailers(_modFolder, "A.esp"));
        Assert.Equal(new BaselineTrailers("B.esp", "2.0", "METAB", "BBBB"), SourceRepository.LatestBaselineTrailers(_modFolder, "B.esp"));
    }

    [Fact]
    public void LatestBaselineTrailers_ReadsThePluginsLatestBaseline_AfterAnUpdate()
    {
        SourceRepository.Track(_modFolder, SourcePreset.Edits, [Baseline(new BaselineTrailers("A.esp", "1.0", null, "OLD"))]);

        SourceRepository.CommitPristineToMain(_modFolder, [Baseline(new BaselineTrailers("A.esp", "1.1", null, "NEW"))]);

        Assert.Equal(new BaselineTrailers("A.esp", "1.1", null, "NEW"), SourceRepository.LatestBaselineTrailers(_modFolder, "A.esp"));
    }

    [Fact]
    public void LatestBaselineTrailers_IsNull_ForAPluginMainHoldsNoBaselineOf()
    {
        SourceRepository.Track(_modFolder, SourcePreset.Edits, [Baseline(new BaselineTrailers("A.esp", "1.0", null, "AAAA"))]);

        Assert.Null(SourceRepository.LatestBaselineTrailers(_modFolder, "B.esp"));
    }

    [Fact]
    public void LatestBaselineTrailers_ReadsMainEvenWithTheEditBranchCheckedOut()
    {
        SourceRepository.Track(_modFolder, SourcePreset.Edits, [Baseline(new BaselineTrailers("Test.esp", "9.9.9", null, "X"))]);
        var gitDir = Path.Combine(_modFolder, ".git");
        Assert.Equal(EditBranch.Name, GitProbe.Run(gitDir, _modFolder, "rev-parse", "--abbrev-ref", "HEAD").Trim());
        File.WriteAllText(Path.Combine(_modFolder, "source", "Test.esp", "npc_", "Test.esp", "000001.json"), "{\"edited\":true}");
        GitProbe.Run(gitDir, _modFolder, "commit", "-qam", "An edit\n\nPlugin: Test.esp\nUpstream-Version: 0.0.1");

        Assert.Equal("9.9.9", SourceRepository.LatestBaselineTrailers(_modFolder, "Test.esp")?.UpstreamVersion);
    }

    private static (IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers) Baseline(BaselineTrailers trailers) =>
        ([new TreeFile($"source/{trailers.Plugin}/npc_/{trailers.Plugin}/000001.json", "{}"u8.ToArray())], trailers);
}
