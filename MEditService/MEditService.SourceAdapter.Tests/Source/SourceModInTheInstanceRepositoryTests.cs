using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.SourceAdapter.Tests.TestSupport.PluginBaselines;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceModInTheInstanceRepositoryTests : IDisposable
{
    private const string Document = "plugin-source/A.esp/npc_/A.esp/000001.json";
    private static readonly PluginAddress A = new("A.esp", TestMod.Name);
    private readonly ScratchDirectory _instance = new("medit-instance-repository-");
    private readonly string _sourceFolder;

    public SourceModInTheInstanceRepositoryTests()
    {
        Git("init", "-q", "-b", "main");
        Git("config", "user.name", "Test");
        Git("config", "user.email", "test@localhost");
        File.WriteAllText(Path.Combine(_instance, "modlist.txt"), "+TestMod\n");
        Git("add", "modlist.txt");
        Git("commit", "-q", "-m", "The modlist");
        _sourceFolder = SourceFolderOf(TestMod.Name);
    }

    public void Dispose() => _instance.Dispose();

    [Fact]
    public void AnInit_CommitsTheSourceFoldersPathsAlone_AndWhatElseIsStagedStaysStaged()
    {
        StageAnotherChange();

        Assert.Null(InitInInstanceRepository(_sourceFolder, commit: true));

        Assert.Equal($"Init {TestMod.Name}", Git("log", "-1", "--format=%s").Trim());
        Assert.Equal(
            [$"source/{TestMod.Name}/.gitattributes", $"source/{TestMod.Name}/.gitignore", $"source/{TestMod.Name}/build.json", $"source/{TestMod.Name}/{Document}"],
            Lines(Git("show", "--name-only", "--format=", "HEAD")));
        Assert.Equal(["modlist.txt"], Lines(Git("diff", "--cached", "--name-only")));
        Assert.False(Path.Exists(Path.Combine(_sourceFolder, ".git")));
    }

    [Fact]
    public void UnderAnIgnoreListThatLetsInEverySourceFolder_AnInit_CommitsTheSourceFolderAlone_AndNoChangeOfTheIgnoreList()
    {
        CommitAnIgnoreListLettingInEverySourceFolder_ThenChangeIt();

        Assert.Null(TestAdapters.Source().Init(_sourceFolder, SourceInits.BuildFile, [OneRecordOf("A.esp")], [], commit: true, heldIn: SourceModIn.InstanceRepository));

        AssertTheInitAtHoldsTheSourceFolderAlone("HEAD");
    }

    [Fact]
    public void UnderAnIgnoreListThatLetsInEverySourceFolder_AnInitThenARepair_CommitsTheSourceFolderAloneAsTheInit_AndNoChangeOfTheIgnoreList()
    {
        CommitAnIgnoreListLettingInEverySourceFolder_ThenChangeIt();
        var repair = new TreeCommit([new TreeFile("npc_/A.esp/000001.json", "{\"EditorID\": \"Repaired\"}"u8.ToArray())], "Repair A.esp");

        Assert.Null(TestAdapters.Source().Init(_sourceFolder, SourceInits.BuildFile, [OneRecordOf("A.esp")], [], commit: true, repair: (A, repair), heldIn: SourceModIn.InstanceRepository));

        AssertTheInitAtHoldsTheSourceFolderAlone("HEAD~1");
    }

    private void CommitAnIgnoreListLettingInEverySourceFolder_ThenChangeIt()
    {
        File.WriteAllText(Path.Combine(_instance, ".gitignore"), "/*\n!/.gitignore\n!/source/\n/source/*\n!/source/*/\n");
        Git("add", ".gitignore");
        Git("commit", "-q", "-m", "Base");
        File.AppendAllText(Path.Combine(_instance, ".gitignore"), "mine/\n");
    }

    private void AssertTheInitAtHoldsTheSourceFolderAlone(string revision)
    {
        var init = Lines(Git("show", "--name-only", "--format=%s", revision));
        Assert.Equal($"Init {TestMod.Name}", init[0]);
        Assert.NotEmpty(init[1..]);
        Assert.All(init[1..], path => Assert.StartsWith($"source/{TestMod.Name}/", path, StringComparison.Ordinal));
        Assert.Equal(" M .gitignore", Git("status", "--porcelain", "--", ".gitignore").TrimEnd());
    }

    [Fact]
    public void AnInitThatCommitsNothing_StagesTheSourceFoldersPaths_AndMovesNoBranch()
    {
        var before = Head();

        Assert.Null(InitInInstanceRepository(_sourceFolder, commit: false));

        Assert.Equal(before, Head());
        Assert.Equal(
            [$"source/{TestMod.Name}/.gitattributes", $"source/{TestMod.Name}/.gitignore", $"source/{TestMod.Name}/build.json", $"source/{TestMod.Name}/{Document}"],
            Lines(Git("diff", "--cached", "--name-only")));
        Assert.True(TestAdapters.Source().IsSourceMod(_sourceFolder));
    }

    [Fact]
    public void ItsSource_ReadsWhatChangedSinceTheLastCommit()
    {
        const string Npc = "plugin-source/A.esp/Npcs/FixtureNpc - 000800_A.esp.json";
        var held = "{\n  \"FormKey\": \"000800:A.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}"u8.ToArray();
        Assert.Null(TestAdapters.Source().Init(
            _sourceFolder, SourceInits.BuildFile, Of([new TreeFile(Npc, held)]), [], commit: true, heldIn: SourceModIn.InstanceRepository));
        var repository = TestAdapters.OpenSourceMod(_sourceFolder, GameRelease.Fallout4);
        Assert.Empty(repository.ChangedSinceLastCommit(A).Value());

        File.WriteAllText(Path.Combine(_sourceFolder, Npc), "{\n  \"FormKey\": \"000800:A.esp\",\n  \"EditorID\": \"Edited\"\n}");

        Assert.Equal([Npc], repository.WorkingTreeChangesOf(A).Value());
        Assert.Equal(new KeyValuePair<string, RecordChange>("000800:A.esp", RecordChange.Modified), Assert.Single(repository.ChangedSinceLastCommit(A).Value()));
    }

    [Fact]
    public void TwoSourceFolders_EachRecordTheBinaryLastWrittenForTheirPluginOfOneName()
    {
        var other = SourceFolderOf("Other");
        Assert.Null(InitInInstanceRepository(_sourceFolder, commit: true));
        Assert.Null(InitInInstanceRepository(other, commit: true));
        var ours = TestAdapters.Source().OverFolder(TestMod.In(_sourceFolder), GameRelease.Fallout4);
        var theirs = TestAdapters.Source().OverFolder(new PluginProvider.FromMod("Other", other, other), GameRelease.Fallout4);

        ours.WriteBinary(A, "OURS", () => { }).Value();
        theirs.WriteBinary(A with { Origin = "Other" }, "THEIRS", () => { }).Value();

        Assert.Equal(["OURS"], ours.LastWrittenBinarySha256s(A).Value());
        Assert.Equal(["THEIRS"], theirs.LastWrittenBinarySha256s(A with { Origin = "Other" }).Value());
    }

    [Fact]
    public void ADecompile_WritesThePluginsSourceAsAWorkingTreeChange_AndRecordsItsBinary()
    {
        Assert.Null(InitInInstanceRepository(_sourceFolder, commit: true));
        var repository = TestAdapters.OpenSourceMod(_sourceFolder, GameRelease.Fallout4);

        Assert.Null(repository.ReplaceSourceFrom(A, [new TreeFile("npc_/A.esp/000002.json", "{}"u8.ToArray())], "DECOMPILED"));

        Assert.Equal(
            [$" D source/{TestMod.Name}/{Document}", $"?? source/{TestMod.Name}/plugin-source/A.esp/npc_/A.esp/000002.json"],
            Lines(Git("status", "--porcelain", "--untracked-files=all")));
        Assert.Equal(["DECOMPILED"], repository.LastWrittenBinarySha256s(A).Value());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ABuild_IsUnpushedOnlyWhileTheRemoteLacksTheLastCommitTouchingTheSourceFolder_AndUncommittedOnlyForItsOwnChanges(bool changedSincePushed)
    {
        Assert.Null(InitInInstanceRepository(_sourceFolder, commit: true));
        Git("remote", "add", "origin", "https://example.com/modlist.git");
        Git("update-ref", "refs/remotes/origin/main", "HEAD");
        if (changedSincePushed)
        {
            File.WriteAllText(Path.Combine(_sourceFolder, "build.json"), "the build file, changed");
            Git("commit", "-q", "-m", "Change the build file", "--", $"source/{TestMod.Name}/build.json");
        }
        StageAnotherChange();
        Git("commit", "-q", "-m", "Another mod");
        StageAnotherChange();

        var source = TestAdapters.Source().SourceToBuild(_sourceFolder, ["build.json"]).Value();

        Assert.Equal((false, changedSincePushed), (source.Uncommitted, source.Unpushed));
    }

    [Fact]
    public void ARepair_CommitsThePluginsSourceAlone_AndWhatElseIsStagedStaysStaged()
    {
        Assert.Null(InitInInstanceRepository(_sourceFolder, commit: true));
        StageAnotherChange();
        var repaired = new TreeCommit([new TreeFile("npc_/A.esp/000001.json", "{\"repaired\":1}"u8.ToArray())], "Repair A.esp");
        var baseline = new TreeCommit([new TreeFile("npc_/A.esp/000001.json", "{\"baseline\":1}"u8.ToArray())], "Decompile A.esp as it was");

        Assert.Null(TestAdapters.OpenSourceMod(_sourceFolder, GameRelease.Fallout4).CommitRepair(A, baseline, repaired, "ABCDEF"));

        Assert.Equal(["Repair A.esp", "Decompile A.esp as it was"], Lines(Git("log", "-2", "--format=%s")));
        Assert.Equal("{\"repaired\":1}", Git("cat-file", "-p", $"HEAD:source/{TestMod.Name}/{Document}"));
        Assert.Equal(["modlist.txt"], Lines(Git("diff", "--cached", "--name-only")));
    }

    [Fact]
    public void AFailedInit_LeavesTheBranchTheIndexAndTheFolderAsTheyWere()
    {
        StageAnotherChange();
        var before = Head();
        GitHooks.Write(_instance, "commit-msg", "exit 1");

        Assert.NotNull(InitInInstanceRepository(_sourceFolder, commit: true));

        Assert.Equal(before, Head());
        Assert.Equal(["modlist.txt"], Lines(Git("diff", "--cached", "--name-only")));
        Assert.False(Directory.Exists(_sourceFolder));
    }

    [Fact]
    public void AnInitWhereNoRepositoryHoldsTheFolder_IsRefusedNamingWhy_AndWritesNothing()
    {
        using var outside = new ScratchDirectory("medit-no-repository-");
        var sourceFolder = Path.Combine(outside, "source", TestMod.Name);

        var refused = Assert.IsType<SourceFailure.Inaccessible>(InitInInstanceRepository(sourceFolder, commit: true));

        Assert.Contains("no repository holds", refused.Reason, StringComparison.Ordinal);
        Assert.False(Directory.Exists(sourceFolder));
    }

    [Fact]
    public void AFolderHoldingNoBuildFile_IsNoSourceMod_SoItCanBePutInTheInstanceRepository()
    {
        Directory.CreateDirectory(_sourceFolder);

        Assert.False(TestAdapters.Source().IsSourceMod(_sourceFolder));
    }

    [Fact]
    public void ABuildFileTheInstanceRepositoryDoesNotTrack_IsNoSourceMod_AsASourceModWhoseOwnRepositoryWasDeleted()
    {
        Assert.Null(InitInInstanceRepository(_sourceFolder, commit: true));
        Assert.True(TestAdapters.Source().IsSourceMod(_sourceFolder));

        Git("rm", "-r", "-q", "--cached", "--", $"source/{TestMod.Name}");

        Assert.False(TestAdapters.Source().IsSourceMod(_sourceFolder));
    }

    [Fact]
    public void ABuildFileInNoRepository_IsNoSourceMod()
    {
        using var outside = new ScratchDirectory("medit-no-repository-");
        File.WriteAllText(Path.Combine(outside, "build.json"), "{}");

        Assert.False(TestAdapters.Source().IsSourceMod(outside));
    }

    private static SourceFailure? InitInInstanceRepository(string sourceFolder, bool commit) =>
        TestAdapters.Source().Init(sourceFolder, SourceInits.BuildFile, [OneRecordOf("A.esp")], [], commit, heldIn: SourceModIn.InstanceRepository);

    private string SourceFolderOf(string mod) => Path.Combine(_instance, "source", mod);

    private void StageAnotherChange()
    {
        File.AppendAllText(Path.Combine(_instance, "modlist.txt"), "+Another\n");
        Git("add", "modlist.txt");
    }

    private string Head() => Git("rev-parse", "HEAD").Trim();

    private static string[] Lines(string text) => text.Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_instance, ".git"), _instance, args);
}
