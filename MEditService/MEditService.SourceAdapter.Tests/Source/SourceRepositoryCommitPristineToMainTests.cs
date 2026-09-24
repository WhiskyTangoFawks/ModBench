using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>The load-bearing claim is "no checkout at all": the edit branch's working tree, index
/// and HEAD come out byte-identical, dirt included.</summary>
public sealed class SourceRepositoryCommitPristineToMainTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-absorb-main-").FullName;
    private const string Plugin = "Test.esp";

    private static void Track(string modFolder, string sourceRelativePath, string content) =>
        SourceRepository.Track(
            modFolder, SourcePreset.Edits,
            [([new TreeFile(sourceRelativePath, System.Text.Encoding.UTF8.GetBytes(content))],
              new BaselineTrailers(Plugin, "1.0.0", "OLDMETA", "OLDBIN"))]);

    private static (IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers) Baseline(
        string relativePath, string content, BaselineTrailers trailers) =>
        ([new TreeFile(relativePath, System.Text.Encoding.UTF8.GetBytes(content))], trailers);

    [Fact]
    public void CommitPristineToMain_AdvancesMain_WithTheNewContentAndFreshTrailers()
    {
        var modFolder = NewModFolder();
        var relativePath = $"source/{Plugin}/npc_/{Plugin}/000001.json";
        try
        {
            Track(modFolder, relativePath, "{\"old\":true}");

            SourceRepository.CommitPristineToMain(
                modFolder, [Baseline(relativePath, "{\"new\":true}", new BaselineTrailers(Plugin, "2.0.0", "NEWMETA", "NEWBIN"))]);

            var gitDir = Path.Combine(modFolder, ".git");
            Assert.Equal("{\"new\":true}", GitProbe.Run(gitDir, modFolder, "show", $"main:{relativePath}"));
            Assert.Equal(new BaselineTrailers(Plugin, "2.0.0", "NEWMETA", "NEWBIN"), SourceRepository.LatestBaselineTrailers(modFolder, Plugin));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void CommitPristineToMain_CommitsEachPlugin_ThenTheChangedTrackedFiles_EachOnItsOwn()
    {
        var root = Directory.CreateTempSubdirectory("medit-absorb-main-").FullName;
        var modFolder = Path.Combine(root, "UpdatedMod");
        Directory.CreateDirectory(Path.Combine(modFolder, "Textures"));
        File.WriteAllText(Path.Combine(modFolder, "Textures", "Thing.dds"), "old pixels");
        try
        {
            PluginBaselines.Track(
                modFolder, SourcePreset.Everything,
                [
                    new TreeFile("source/A.esp/npc_/A.esp/000001.json", "{}"u8.ToArray()),
                    new TreeFile("source/B.esp/npc_/B.esp/000001.json", "{}"u8.ToArray()),
                ]);
            File.WriteAllText(Path.Combine(modFolder, "Textures", "Thing.dds"), "new pixels");

            SourceRepository.CommitPristineToMain(
                modFolder,
                [
                    Baseline("source/A.esp/npc_/A.esp/000001.json", "{\"a\":2}", new BaselineTrailers("A.esp", "2.0", null, "AAAA")),
                    Baseline("source/B.esp/npc_/B.esp/000001.json", "{\"b\":2}", new BaselineTrailers("B.esp", null, null, "BBBB")),
                ],
                [new TrackedFileChange("Textures/Thing.dds", TrackedFileChangeKind.Modified, StagedAlready: false)]);

            var gitDir = Path.Combine(modFolder, ".git");
            Assert.Equal(
                ["Update UpdatedMod", "Update B.esp", "Update A.esp to 2.0"],
                GitProbe.Run(gitDir, modFolder, "log", "-3", "--format=%s", "main").Split('\n', StringSplitOptions.RemoveEmptyEntries));
            Assert.Equal(["source/A.esp/npc_/A.esp/000001.json"], PathsIn(modFolder, "main~2"));
            Assert.Equal(["source/B.esp/npc_/B.esp/000001.json"], PathsIn(modFolder, "main~1"));
            Assert.Equal(["Textures/Thing.dds"], PathsIn(modFolder, "main"));
            Assert.Equal("new pixels", GitProbe.Run(gitDir, modFolder, "show", "main:Textures/Thing.dds"));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    // "[a].dds" read as a glob also names "a.dds", which changed on disk but is not in the answer.
    [Fact]
    public void CommitPristineToMain_CommitsExactlyTheNamedTrackedFiles_WhenANameHoldsGlobCharacters()
    {
        var modFolder = NewModFolder();
        try
        {
            Directory.CreateDirectory(Path.Combine(modFolder, "Textures"));
            File.WriteAllText(Path.Combine(modFolder, "Textures", "[a].dds"), "old");
            File.WriteAllText(Path.Combine(modFolder, "Textures", "a.dds"), "old");
            PluginBaselines.Track(
                modFolder, SourcePreset.Everything, [new TreeFile($"source/{Plugin}/npc_/{Plugin}/000001.json", "{}"u8.ToArray())]);
            File.WriteAllText(Path.Combine(modFolder, "Textures", "[a].dds"), "new");
            File.WriteAllText(Path.Combine(modFolder, "Textures", "a.dds"), "new");

            SourceRepository.CommitPristineToMain(
                modFolder, [], [new TrackedFileChange("Textures/[a].dds", TrackedFileChangeKind.Modified, StagedAlready: false)]);

            Assert.Equal(["Textures/[a].dds"], PathsIn(modFolder, "main"));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    private static string[] PathsIn(string modFolder, string revision) =>
        GitProbe.Run(Path.Combine(modFolder, ".git"), modFolder, "show", "--name-only", "--format=", revision)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries);

    [Fact]
    public void CommitPristineToMain_AdvancesEachPluginsParkedRef_ToItsOwnNewBaselineCommit()
    {
        var modFolder = NewModFolder();
        var relativePath = $"source/{Plugin}/npc_/{Plugin}/000001.json";
        try
        {
            Track(modFolder, relativePath, "{\"old\":true}");
            File.WriteAllText(Path.Combine(modFolder, ".gitignore"), "# edited by hand\n");

            SourceRepository.CommitPristineToMain(
                modFolder, [Baseline(relativePath, "{\"new\":true}", new BaselineTrailers(Plugin, null, null, "NEWBIN"))],
                [new TrackedFileChange(".gitignore", TrackedFileChangeKind.Modified, StagedAlready: false)]);

            var gitDir = Path.Combine(modFolder, ".git");
            var pluginsBaselineSha = GitProbe.Run(gitDir, modFolder, "rev-parse", "refs/heads/main~1").Trim();
            var parkedSha = GitProbe.Run(gitDir, modFolder, "rev-parse", $"refs/medit/last-compile/{Plugin}").Trim();
            Assert.Equal(pluginsBaselineSha, parkedSha);
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

            SourceRepository.CommitPristineToMain(
                modFolder, [Baseline(relativePath, "{\"upstream\":true}", new BaselineTrailers(Plugin, null, null, "NEWBIN"))]);

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
