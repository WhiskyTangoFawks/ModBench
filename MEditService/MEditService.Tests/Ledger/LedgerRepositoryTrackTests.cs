using MEditService.Core.Ledger;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #414/ADR-0041: <see cref="LedgerRepository.Track"/> — the repo-layer verb the Track gesture
/// calls once it has serialized every record and computed provenance. Built up one behavior at a
/// time (init+commit+trailers here; .gitignore/branch/config/parked-ref/cleanup/PATH-check in
/// their own test files) against a real git repo in a scratch mod folder — never a mocked git,
/// same posture as <see cref="GitCliTests"/>.
/// </summary>
public sealed class LedgerRepositoryTrackTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-track-").FullName;

    [Fact]
    public void Track_CommitsEveryPristineFileToMain_WithItsExactBytes()
    {
        var modFolder = NewModFolder();
        try
        {
            var relativePath = Path.Combine("StillHere.esp.ledger", "npc_", "StillHere.esp", "000800.json");
            var content = "{\"formKey\":\"000800:StillHere.esp\"}"u8.ToArray();
            var files = new[] { new PristineFile(relativePath, content) };
            var trailers = new TrackProvenance(null, null, new Dictionary<string, string>());

            LedgerRepository.Track(modFolder, LedgerPreset.Edits, files, trailers);

            var gitDir = Path.Combine(modFolder, ".git");
            var shown = GitCli.Run(gitDir, modFolder, "show", $"main:{relativePath.Replace('\\', '/')}");
            Assert.Equal("{\"formKey\":\"000800:StillHere.esp\"}", shown);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void Track_WritesProvenanceAsCommitTrailersOnTheMainBaseline()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[] { new PristineFile("Test.esp.ledger/npc_/Test.esp/000001.json", "{}"u8.ToArray()) };
            var trailers = new TrackProvenance(
                UpstreamVersion: "1.2.3",
                MetaSha256: null,
                BinarySha256ByPlugin: new Dictionary<string, string> { ["Test.esp"] = "ABCDEF0123" });

            LedgerRepository.Track(modFolder, LedgerPreset.Edits, files, trailers);

            var gitDir = Path.Combine(modFolder, ".git");
            var body = GitCli.Run(gitDir, modFolder, "log", "-1", "--format=%B", "main");
            Assert.Contains("Upstream-Version: 1.2.3", body);
            Assert.Contains("Binary-SHA256: Test.esp=ABCDEF0123", body);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
