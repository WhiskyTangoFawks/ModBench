using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceToBuildTests : IDisposable
{
    private readonly ScratchDirectory _root = new("medit-source-to-build-");
    private readonly string _sourceFolder;

    public SourceToBuildTests() => _sourceFolder = Directory.CreateDirectory(Path.Combine(_root, TestMod.Name)).FullName;

    public void Dispose() => _root.Dispose();

    [Fact]
    public void AnInitializedSource_BuildsItsAssetsAndItsPlugins()
    {
        Assert.Null(TestAdapters.Source().Init(
            _sourceFolder, SourceInits.ManifestOf("The Output"), [PluginBaselines.OneRecordOf("B.esp"), PluginBaselines.OneRecordOf("A.esp")],
            [new Asset("textures/Sub Folder/a.dds", () => new MemoryStream("texture"u8.ToArray()))]));

        var source = Built();

        Assert.Equal(["A.esp", "B.esp"], source.Plugins);
        var asset = Assert.Single(source.Assets);
        Assert.Equal("textures/Sub Folder/a.dds", asset.Path);
        using var opened = new StreamReader(asset.Open());
        Assert.Equal("texture", opened.ReadToEnd());
    }

    [Fact]
    public void ALeftoverInTheAssets_IsNoAssetOfTheBuild()
    {
        Assert.Null(TestAdapters.Source().Init(_sourceFolder, SourceInits.ManifestOf("Mod"), [], [new Asset("textures/a.dds", () => new MemoryStream("texture"u8.ToArray()))]));
        TempLeftover.DeadWriters(Path.Combine(_sourceFolder, "assets", "textures"));

        Assert.Equal(["textures/a.dds"], Built().Assets.Select(asset => asset.Path));
    }

    [Theory]
    [InlineData("assets/textures/new.dds", true)]
    [InlineData("notes.txt", false)]
    public void ASourceWithARemote_SaysWhetherItsWorkingTreeHoldsChangesNoCommitHolds(string written, bool uncommitted)
    {
        Assert.Null(TestAdapters.Source().Init(_sourceFolder, SourceInits.ManifestOf("Mod"), [], []));
        Git("remote", "add", "origin", "https://example.com/mod.git");
        Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(_sourceFolder, written)).Require());
        File.WriteAllText(Path.Combine(_sourceFolder, written), "new");

        Assert.Equal(uncommitted, Built().Uncommitted);
    }

    [Theory]
    [InlineData("refs/remotes/origin/main", false)]
    [InlineData("refs/heads/kept", true)]
    public void ASourceWithARemote_SaysWhetherItsRemoteHoldsTheCommitAtHead_AsTheLastFetchSaw(string holding, bool unpushed)
    {
        Assert.Null(TestAdapters.Source().Init(_sourceFolder, SourceInits.ManifestOf("Mod"), [], []));
        Git("remote", "add", "origin", "https://example.com/mod.git");
        Git("update-ref", holding, "HEAD");

        Assert.Equal(unpushed, Built().Unpushed);
    }

    [Theory]
    [InlineData("fork", "origin", "origin")]
    [InlineData("upstream", "fork", "fork")]
    public void ASourceWithRemotes_SaysWhetherOrigin_ElseTheFirstRemoteByName_HoldsTheCommitAtHead(string added, string addedNext, string holding)
    {
        Assert.Null(TestAdapters.Source().Init(_sourceFolder, SourceInits.ManifestOf("Mod"), [], []));
        Git("remote", "add", added, $"https://example.com/{added}.git");
        Git("remote", "add", addedNext, $"https://example.com/{addedNext}.git");
        Git("update-ref", $"refs/remotes/{holding}/main", "HEAD");

        Assert.False(Built().Unpushed);
    }

    [PosixFact]
    public void AssetsWhosePathsDifferOnlyInCase_AreUnreadable_NamingBoth()
    {
        WriteAsset("Scripts/a.pex");
        WriteAsset("scripts/A.pex");

        var failure = TestAdapters.Source().SourceToBuild(_sourceFolder).Stopped();

        Assert.Equal(
            $"'{Path.Combine(_sourceFolder, "assets")}' holds 'Scripts/a.pex' and 'scripts/A.pex', which differ only in case: one mod folder cannot hold both on Windows.",
            Assert.IsType<SourceFailure.Unreadable>(failure).Reason);
    }

    private void WriteAsset(string path)
    {
        var file = Path.Combine(_sourceFolder, "assets", path);
        Directory.CreateDirectory(Path.GetDirectoryName(file).Require());
        File.WriteAllText(file, path);
    }

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_sourceFolder, ".git"), _sourceFolder, args);

    private SourceToBuild Built() => TestAdapters.Source().SourceToBuild(_sourceFolder).Value();
}
