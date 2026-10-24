using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryCommitRepairTests : IDisposable
{
    private const string Plugin = "A.esp";
    private const string Sha = "ABCDEF0123";
    private const string Was = "plugin-source/A.esp/npc_/A.esp/000001.json";
    private static readonly PluginAddress Address = new(Plugin, "TestMod");
    private static readonly TreeCommit Flagged = new([File("npc_/A.esp/000001.json", "{\"flagged\":1}")], "Flag A.esp");
    private static readonly TreeCommit Repaired = new([File("npc_/A.esp/000001.json", "{\"repaired\":1}")], "Repair A.esp");
    private readonly ScratchDirectory _modFolder = new("medit-commit-repair-");

    public SourceRepositoryCommitRepairTests() =>
        TestAdapters.Source().Init(_modFolder, [([File("npc_/A.esp/000001.json", "{\"was\":1}")], PluginBaselines.Decompiled(Plugin))]);

    public void Dispose() => _modFolder.Dispose();

    [Fact]
    public void ARepair_CommitsTheFlaggedTree_ThenTheRepairedTree_OnTheCheckedOutBranch_AndParksTheBinary()
    {
        var before = Head();

        Assert.Null(Repository.CommitRepair(Address, Flagged, Repaired, Sha));

        Assert.Equal(["Repair A.esp", "Flag A.esp"], Git("log", "-2", "--format=%s").TrimEnd('\n').Split('\n'));
        Assert.Equal(before, Git("rev-parse", "HEAD~2").Trim());
        Assert.Equal("{\"flagged\":1}", Git("cat-file", "-p", $"HEAD~1:{Was}"));
        Assert.Equal("{\"repaired\":1}", Git("cat-file", "-p", $"HEAD:{Was}"));
        Assert.Empty(Git("status", "--porcelain"));
        Assert.Equal([Sha], Repository.LastWrittenBinarySha256s(Address).Value());
    }

    [Fact]
    public void ARepair_LeavesWhatIsStagedOutsideThePluginsSource_StagedAndUncommitted()
    {
        var other = Path.Combine(Directory.CreateDirectory(Path.Combine(_modFolder, "plugin-source", "B.esp")).FullName, "b.json");
        System.IO.File.WriteAllText(other, "{}");
        Git("add", "--", other);

        Assert.Null(Repository.CommitRepair(Address, Flagged, Repaired, Sha));

        Assert.Equal("A  plugin-source/B.esp/b.json", Git("status", "--porcelain").TrimEnd('\n'));
    }

    [Fact]
    public void ARepairWhoseSecondCommitFails_LeavesTheBranchTheIndexAndTheSourceAsTheyWere()
    {
        var before = Head();
        GitHooks.Write(_modFolder, "commit-msg", "grep -q Repair \"$1\" && exit 1\nexit 0");

        Assert.IsType<SourceFailure.GitFailed>(Repository.CommitRepair(Address, Flagged, Repaired, Sha));

        Assert.Equal(before, Head());
        Assert.Empty(Git("status", "--porcelain"));
        Assert.Equal("{\"was\":1}", System.IO.File.ReadAllText(Path.Combine(_modFolder, Was)));
        Assert.Empty(Repository.LastWrittenBinarySha256s(Address).Value());
    }

    private string Head() => Git("rev-parse", "HEAD").Trim();

    private ISourceRepository Repository => TestAdapters.OpenSourceMod(_modFolder, GameRelease.Fallout4);

    private static TreeFile File(string underRoot, string text) => new(underRoot, System.Text.Encoding.UTF8.GetBytes(text));

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);
}
