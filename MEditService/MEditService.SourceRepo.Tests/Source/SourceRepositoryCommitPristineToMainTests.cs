using MEditService.Codec.Serialization;
using MEditService.SourceRepo;
using MEditService.SourceRepo.Tests.TestSupport;
using MEditService.TestSupport.TestSupport;

namespace MEditService.SourceRepo.Tests.Source;

/// <summary>The load-bearing claim is "no checkout at all": the edit branch's working tree, index
/// and HEAD come out byte-identical, dirt included.</summary>
public sealed class SourceRepositoryCommitPristineToMainTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-absorb-main-").FullName;
    private const string Plugin = "Test.esp";

    private static string Track(string modFolder, string sourceRelativePath, string content)
    {
        var files = new[] { new TreeFile(sourceRelativePath, System.Text.Encoding.UTF8.GetBytes(content)) };
        var trailers = new TrackProvenance("1.0.0", "OLDMETA", new Dictionary<string, string> { [Plugin] = "OLDBIN" });
        SourceRepository.Track(modFolder, SourcePreset.Edits, files, trailers);
        return Path.Combine(modFolder, ".git");
    }

    [Fact]
    public void CommitPristineToMain_AdvancesMain_WithTheNewContentAndFreshTrailers()
    {
        var modFolder = NewModFolder();
        var relativePath = $"source/{Plugin}/npc_/{Plugin}/000001.json";
        try
        {
            Track(modFolder, relativePath, "{\"old\":true}");

            var newFiles = new[] { new TreeFile(relativePath, "{\"new\":true}"u8.ToArray()) };
            var newTrailers = new TrackProvenance("2.0.0", "NEWMETA", new Dictionary<string, string> { [Plugin] = "NEWBIN" });
            SourceRepository.CommitPristineToMain(modFolder, newFiles, newTrailers);

            var gitDir = Path.Combine(modFolder, ".git");
            Assert.Equal("{\"new\":true}", GitProbe.Run(gitDir, modFolder, "show", $"main:{relativePath}"));

            var baseline = SourceRepository.LatestBaselineTrailers(modFolder, Plugin);
            Assert.NotNull(baseline);
            Assert.Equal("2.0.0", baseline.UpstreamVersion);
            Assert.Equal("NEWMETA", baseline.MetaSha256);
            Assert.Equal("NEWBIN", baseline.BinarySha256);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void CommitPristineToMain_AdvancesTheParkedRef_ToTheNewBaselineCommit()
    {
        var modFolder = NewModFolder();
        var relativePath = $"source/{Plugin}/npc_/{Plugin}/000001.json";
        try
        {
            Track(modFolder, relativePath, "{\"old\":true}");

            var newFiles = new[] { new TreeFile(relativePath, "{\"new\":true}"u8.ToArray()) };
            var newTrailers = new TrackProvenance(null, null, new Dictionary<string, string> { [Plugin] = "NEWBIN" });
            SourceRepository.CommitPristineToMain(modFolder, newFiles, newTrailers);

            var gitDir = Path.Combine(modFolder, ".git");
            var mainSha = GitProbe.Run(gitDir, modFolder, "rev-parse", "refs/heads/main").Trim();
            var parkedSha = GitProbe.Run(gitDir, modFolder, "rev-parse", $"refs/medit/last-compile/{Plugin}").Trim();
            Assert.Equal(mainSha, parkedSha);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void CommitPristineToMain_TouchesNeitherTheEditBranchsWorkingTreeNorItsHeadNorItsDirt()
    {
        var modFolder = NewModFolder();
        var relativePath = $"source/{Plugin}/npc_/{Plugin}/000001.json";
        try
        {
            Track(modFolder, relativePath, "{\"old\":true}");

            // Real dirt on the edit branch, exactly like an in-progress user edit — this must survive
            // the absorb untouched.
            var fullPath = Path.Combine(modFolder, relativePath);
            File.WriteAllText(fullPath, "{\"my-own-edit\":true}");

            var gitDir = Path.Combine(modFolder, ".git");
            var branchBefore = GitProbe.Run(gitDir, modFolder, "rev-parse", "--abbrev-ref", "HEAD").Trim();
            var headBefore = GitProbe.Run(gitDir, modFolder, "rev-parse", "HEAD").Trim();
            // RebaseEditBranch refuses before touching the branch whenever the source tree carries
            // dirt, naming every dirty path in the refusal — a public probe for exactly that fact.
            var dirtBefore = SourceRepository.RebaseEditBranch(modFolder);
            Assert.Equal(RebaseOutcome.Refused, dirtBefore.Outcome);
            var fileContentBefore = File.ReadAllText(fullPath);

            var newFiles = new[] { new TreeFile(relativePath, "{\"upstream\":true}"u8.ToArray()) };
            var newTrailers = new TrackProvenance(null, null, new Dictionary<string, string> { [Plugin] = "NEWBIN" });
            SourceRepository.CommitPristineToMain(modFolder, newFiles, newTrailers);

            Assert.Equal(branchBefore, GitProbe.Run(gitDir, modFolder, "rev-parse", "--abbrev-ref", "HEAD").Trim());
            Assert.Equal(headBefore, GitProbe.Run(gitDir, modFolder, "rev-parse", "HEAD").Trim());
            var dirtAfter = SourceRepository.RebaseEditBranch(modFolder);
            Assert.Equal(RebaseOutcome.Refused, dirtAfter.Outcome);
            Assert.Equal(dirtBefore.RefusalReason, dirtAfter.RefusalReason);
            Assert.Equal(fileContentBefore, File.ReadAllText(fullPath));
            Assert.Equal(EditBranch.Name, branchBefore);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
