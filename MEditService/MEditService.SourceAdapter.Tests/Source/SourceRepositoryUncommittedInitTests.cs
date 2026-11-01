using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryUncommittedInitTests : IDisposable
{
    private const string Plugin = "A.esp";
    private const string Sha = "ABCDEF0123";
    private const string Compiled = "0123456789";
    private const string Was = "plugin-source/A.esp/npc_/A.esp/000001.json";
    private static readonly PluginAddress Address = new(Plugin, "TestMod");
    private readonly ScratchDirectory _modFolder = new("medit-uncommitted-init-");

    public SourceRepositoryUncommittedInitTests() =>
        Assert.Null(TestAdapters.Source().Init(
            _modFolder, SourceInits.BuildFile, [([File("npc_/A.esp/000001.json", "{\"was\":1}")], PluginBaselines.Decompiled(Plugin, Sha))],
            [new FileToCopy("textures/a.dds", () => new MemoryStream(Encoding.UTF8.GetBytes("texture")))], commit: false));

    public void Dispose() => _modFolder.Dispose();

    [Fact]
    public void TheIndex_HoldsWhatAnInitTracks_AndNothingIsCommitted_YetTheModIsASourceMod()
    {
        Assert.True(TestAdapters.Source().IsSourceMod(_modFolder));
        Assert.Equal(
            [".gitignore", "build.json", Was, "textures/a.dds"],
            Git("ls-files").Split('\n', StringSplitOptions.RemoveEmptyEntries));
        Assert.Equal(string.Empty, Git("for-each-ref", "refs/heads"));
    }

    [Fact]
    public void ACompile_OverItsPlugin_Succeeds_AndTheBinaryItWroteIsTheLastWritten()
    {
        Assert.True(Repository.WriteBinary(Address, Compiled, () => { }).Value());

        Assert.Equal([Compiled], Repository.LastWrittenBinarySha256s(Address).Value());
    }

    [Fact]
    public void ThePluginTheInitDecompiled_ReadsAsWhatModbenchLastWrote_SoItIsNotSeenAsChanged()
    {
        Assert.Equal([Sha], Repository.LastWrittenBinarySha256s(Address).Value());
    }

    [Fact]
    public void ARepair_MakesTheRootCommitOfThePluginsSourceAlone_LeavingTheRestStaged()
    {
        var repaired = new TreeCommit([File("npc_/A.esp/000001.json", "{\"repaired\":1}")], "Repair A.esp");
        var baseline = new TreeCommit([File("npc_/A.esp/000001.json", "{\"baseline\":1}")], "Decompile A.esp as it was");

        Assert.Null(Repository.CommitRepair(Address, baseline, repaired, Compiled));

        Assert.Equal(["Repair A.esp", "Decompile A.esp as it was"], Git("log", "--format=%s").TrimEnd('\n').Split('\n'));
        Assert.Equal("{\"repaired\":1}", Git("cat-file", "-p", $"HEAD:{Was}"));
        Assert.Equal([Compiled], Repository.LastWrittenBinarySha256s(Address).Value());
        Assert.Contains("A  textures/a.dds", Git("status", "--porcelain"), StringComparison.Ordinal);
    }

    [Fact]
    public void ARepairWhoseSecondCommitFails_LeavesNoCommitAndTheFilesStaged()
    {
        GitHooks.Write(_modFolder, "commit-msg", "grep -q Repair \"$1\" && exit 1\nexit 0");
        var repaired = new TreeCommit([File("npc_/A.esp/000001.json", "{\"repaired\":1}")], "Repair A.esp");
        var baseline = new TreeCommit([File("npc_/A.esp/000001.json", "{\"baseline\":1}")], "Decompile A.esp as it was");

        Assert.IsType<SourceFailure.GitFailed>(Repository.CommitRepair(Address, baseline, repaired, Compiled));

        Assert.Equal(string.Empty, Git("for-each-ref", "refs/heads"));
        Assert.Equal("{\"was\":1}", System.IO.File.ReadAllText(Path.Combine(_modFolder, Was)));
        Assert.Equal(
            [".gitignore", "build.json", Was, "textures/a.dds"],
            Git("ls-files").Split('\n', StringSplitOptions.RemoveEmptyEntries));
    }

    [Fact]
    public void ARepositoryWhoseInitMarkIsInAnotherSection_IsNotASourceMod()
    {
        var config = Path.Combine(_modFolder, ".git", "config");
        System.IO.File.WriteAllText(config, System.IO.File.ReadAllText(config).Replace("[medit]", "[other]", StringComparison.Ordinal));

        Assert.False(TestAdapters.Source().IsSourceMod(_modFolder));
    }

    private ISourceRepository Repository => TestAdapters.OpenSourceMod(_modFolder, GameRelease.Fallout4);

    private static TreeFile File(string underRoot, string text) => new(underRoot, Encoding.UTF8.GetBytes(text));

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);
}
