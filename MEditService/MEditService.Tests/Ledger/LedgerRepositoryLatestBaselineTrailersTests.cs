using MEditService.Core.Ledger;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #417 B3: <see cref="LedgerRepository.LatestBaselineTrailers"/> — reads back exactly what
/// <see cref="LedgerRepository.Track"/> (and, later, Absorb Upstream Update's plumbing commit)
/// wrote onto <c>main</c>'s tip, the meta-tell classifier's other data source.
/// </summary>
public sealed class LedgerRepositoryLatestBaselineTrailersTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-baseline-trailers-").FullName;

    [Fact]
    public void LatestBaselineTrailers_ReadsBackTracksOwnTrailers()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[] { new PristineFile("Test.esp.ledger/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            var trailers = new TrackProvenance(
                UpstreamVersion: "1.2.3",
                MetaSha256: "META0001",
                BinarySha256ByPlugin: new Dictionary<string, string> { ["Test.esp"] = "BIN0001" });
            LedgerRepository.Track(modFolder, LedgerPreset.Edits, files, trailers);

            var read = LedgerRepository.LatestBaselineTrailers(modFolder, "Test.esp");

            Assert.NotNull(read);
            Assert.Equal("1.2.3", read.UpstreamVersion);
            Assert.Equal("META0001", read.MetaSha256);
            Assert.Equal("BIN0001", read.BinarySha256);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void LatestBaselineTrailers_PicksTheRightPluginsOwnBinaryHash_WhenTheFolderHoldsMoreThanOne()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[]
            {
                new PristineFile("A.esp.ledger/npc_/A.esp/000001.json", "{}"u8.ToArray()),
                new PristineFile("B.esp.ledger/npc_/B.esp/000001.json", "{}"u8.ToArray()),
            };
            var trailers = new TrackProvenance(null, null, new Dictionary<string, string> { ["A.esp"] = "AAAA", ["B.esp"] = "BBBB" });
            LedgerRepository.Track(modFolder, LedgerPreset.Edits, files, trailers);

            Assert.Equal("AAAA", LedgerRepository.LatestBaselineTrailers(modFolder, "A.esp")?.BinarySha256);
            Assert.Equal("BBBB", LedgerRepository.LatestBaselineTrailers(modFolder, "B.esp")?.BinarySha256);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void LatestBaselineTrailers_ReadsMainEvenWithTheEditBranchCheckedOut()
    {
        // Track always leaves the edit branch checked out (ADR-0041) — this is the normal state of
        // a tracked mod's working tree at every point after Track returns, so reading "main" here
        // must not silently mean "whatever's checked out".
        var modFolder = NewModFolder();
        try
        {
            var files = new[] { new PristineFile("Test.esp.ledger/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            var trailers = new TrackProvenance("9.9.9", null, new Dictionary<string, string> { ["Test.esp"] = "X" });
            LedgerRepository.Track(modFolder, LedgerPreset.Edits, files, trailers);

            var gitDir = Path.Combine(modFolder, ".git");
            Assert.Equal(LedgerRepository.EditBranchName, GitCli.Run(gitDir, modFolder, "rev-parse", "--abbrev-ref", "HEAD").Trim());

            Assert.Equal("9.9.9", LedgerRepository.LatestBaselineTrailers(modFolder, "Test.esp")?.UpstreamVersion);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
