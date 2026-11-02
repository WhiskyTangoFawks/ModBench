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
    public void ACopiedFolder_IsEachFileUnderIt_AndACopiedFile_IsItself_ByItsPathInTheSourceFolder()
    {
        Assert.Null(TestAdapters.Source().Init(
            _sourceFolder, SourceInits.BuildFile, [PluginBaselines.OneRecordOf("A.esp")],
            [Texture("textures/Sub Folder/a.dds"), Texture("textures/b.dds"), Texture("readme.txt"), Texture("meshes/c.nif")], commit: true));

        var source = Built(["textures", "readme.txt"]);

        Assert.Equal(["textures/Sub Folder/a.dds", "textures/b.dds", "readme.txt"], source.Files.Select(file => file.Path));
        using var opened = new StreamReader(source.Files[0].Open());
        Assert.Equal("texture", opened.ReadToEnd());
    }

    [Fact]
    public void ALeftoverInACopiedFolder_IsNoFileOfTheBuild()
    {
        Assert.Null(TestAdapters.Source().Init(_sourceFolder, SourceInits.BuildFile, [], [Texture("textures/a.dds")], commit: true));
        TempLeftover.DeadWriters(Path.Combine(_sourceFolder, "textures"));

        Assert.Equal(["textures/a.dds"], Built(["textures"]).Files.Select(file => file.Path));
    }

    [Fact]
    public void ACopiedPathTheSourceFolderDoesNotHold_IsUnreadable_NamingIt()
    {
        Assert.Null(TestAdapters.Source().Init(_sourceFolder, SourceInits.BuildFile, [], [], commit: true));

        var failure = TestAdapters.Source().SourceToBuild(_sourceFolder, ["textures"]).Stopped();

        Assert.Equal($"'{_sourceFolder}' holds no 'textures' to build from.", Assert.IsType<SourceFailure.Unreadable>(failure).Reason);
    }

    [Theory]
    [InlineData("textures/new.dds", true)]
    [InlineData("notes.txt", false)]
    public void ASourceWithARemote_SaysWhetherItsWorkingTreeHoldsChangesNoCommitHolds(string written, bool uncommitted)
    {
        Assert.Null(TestAdapters.Source().Init(_sourceFolder, SourceInits.BuildFile, [], [Texture("textures/a.dds")], commit: true));
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
        Assert.Null(TestAdapters.Source().Init(_sourceFolder, SourceInits.BuildFile, [], [], commit: true));
        Git("remote", "add", "origin", "https://example.com/mod.git");
        Git("update-ref", holding, "HEAD");

        Assert.Equal(unpushed, Built().Unpushed);
    }

    [Fact]
    public void ASourceWithARemoteAndNoCommitYet_IsNotUnpushed_ButHoldsChangesNoCommitHolds()
    {
        Assert.Null(TestAdapters.Source().Init(_sourceFolder, SourceInits.BuildFile, [], [Texture("textures/a.dds")], commit: false));
        Git("remote", "add", "origin", "https://example.com/mod.git");

        var source = Built();

        Assert.Equal((true, false), (source.Uncommitted, source.Unpushed));
    }

    [Fact]
    public void ASourceWithARemoteWhoseHeadGitCannotRead_IsAFailure_NotUnpushed()
    {
        Assert.Null(TestAdapters.Source().Init(_sourceFolder, SourceInits.BuildFile, [], [], commit: true));
        Git("remote", "add", "origin", "https://example.com/mod.git");
        File.WriteAllText(Path.Combine(_sourceFolder, ".git", "refs", "heads", "main"), "not a commit");

        Assert.IsType<SourceFailure.GitFailed>(TestAdapters.Source().SourceToBuild(_sourceFolder, []).Stopped());
    }

    [Theory]
    [InlineData("fork", "origin", "origin")]
    [InlineData("upstream", "fork", "fork")]
    public void ASourceWithRemotes_SaysWhetherOrigin_ElseTheFirstRemoteByName_HoldsTheCommitAtHead(string added, string addedNext, string holding)
    {
        Assert.Null(TestAdapters.Source().Init(_sourceFolder, SourceInits.BuildFile, [], [], commit: true));
        Git("remote", "add", added, $"https://example.com/{added}.git");
        Git("remote", "add", addedNext, $"https://example.com/{addedNext}.git");
        Git("update-ref", $"refs/remotes/{holding}/main", "HEAD");

        Assert.False(Built().Unpushed);
    }

    [PosixFact]
    public void CopiedFilesWhosePathsDifferOnlyInCase_AreUnreadable_NamingBoth()
    {
        WriteFile("Scripts/a.pex");
        WriteFile("scripts/A.pex");

        var failure = TestAdapters.Source().SourceToBuild(_sourceFolder, ["Scripts", "scripts"]).Stopped();

        Assert.Equal(
            $"'{_sourceFolder}' holds 'Scripts/a.pex' and 'scripts/A.pex', which differ only in case: one mod folder cannot hold both on Windows.",
            Assert.IsType<SourceFailure.Unreadable>(failure).Reason);
    }

    private void WriteFile(string path)
    {
        var file = Path.Combine(_sourceFolder, path);
        Directory.CreateDirectory(Path.GetDirectoryName(file).Require());
        File.WriteAllText(file, path);
    }

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_sourceFolder, ".git"), _sourceFolder, args);

    private SourceToBuild Built(IReadOnlyList<string>? copied = null) => TestAdapters.Source().SourceToBuild(_sourceFolder, copied ?? []).Value();

    private static FileToCopy Texture(string path) => new(path, () => new MemoryStream("texture"u8.ToArray()));
}
