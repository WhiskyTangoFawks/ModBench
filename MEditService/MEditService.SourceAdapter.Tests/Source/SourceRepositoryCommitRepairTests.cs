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
    private static readonly TreeCommit Repaired = new([File("npc_/A.esp/000001.json", "{\"repaired\":1}")], "Repair A.esp");
    private readonly ScratchDirectory _modFolder = new("medit-commit-repair-");

    public SourceRepositoryCommitRepairTests() =>
        TestAdapters.Source().Init(_modFolder, [([File("npc_/A.esp/000001.json", "{\"was\":1}")], PluginBaselines.Decompiled(Plugin))]);

    public void Dispose() => _modFolder.Dispose();

    [Fact]
    public void ARepair_CommitsTheRepairedTree_OnTheCheckedOutBranch_AndParksTheBinary()
    {
        var before = Head();

        Assert.Null(Repository.CommitRepair(Address, Repaired, Sha));

        Assert.Equal("Repair A.esp", Git("log", "-1", "--format=%s").TrimEnd('\n'));
        Assert.Equal(before, Git("rev-parse", "HEAD~1").Trim());
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

        Assert.Null(Repository.CommitRepair(Address, Repaired, Sha));

        Assert.Equal("A  plugin-source/B.esp/b.json", Git("status", "--porcelain").TrimEnd('\n'));
    }

    [Fact]
    public void ARepairWhoseCommitFails_LeavesTheBranchTheIndexAndTheSourceAsTheyWere()
    {
        var before = Head();
        GitHooks.Write(_modFolder, "commit-msg", "grep -q Repair \"$1\" && exit 1\nexit 0");

        Assert.IsType<SourceFailure.GitFailed>(Repository.CommitRepair(Address, Repaired, Sha));

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
