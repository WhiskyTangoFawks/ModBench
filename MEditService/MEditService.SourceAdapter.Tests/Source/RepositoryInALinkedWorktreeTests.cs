using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.SourceAdapter.Tests.TestSupport.PluginBaselines;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class RepositoryInALinkedWorktreeTests : IDisposable
{
    private readonly ScratchDirectory _instance = new("medit-linked-main-");
    private readonly ScratchDirectory _linked = new("medit-linked-worktree-");
    private readonly ISourceRepository _repository;

    public RepositoryInALinkedWorktreeTests()
    {
        Git("init", "-q", "-b", "main");
        Git("config", "user.name", "Test");
        Git("config", "user.email", "test@localhost");
        File.WriteAllText(Path.Combine(_instance, "modlist.txt"), "+TestMod\n");
        Git("add", "modlist.txt");
        Git("commit", "-q", "-m", "The modlist");
        var sourceFolder = Path.Combine(_instance, "source", TestMod.Name);
        Assert.Null(TestAdapters.Source().Init(
            sourceFolder, SourceInits.BuildFile, [OneRecordOf("A.esp")], [], commit: true, heldIn: SourceModIn.InstanceRepository));

        var worktree = Path.Combine(_linked, "tree");
        Git("worktree", "add", "-q", "-b", "linked", worktree);
        var linkedSourceFolder = Path.Combine(worktree, "source", TestMod.Name);
        _repository = TestAdapters.Source().OverFolder(new PluginProvider.FromMod(TestMod.Name, linkedSourceFolder, linkedSourceFolder), GameRelease.Fallout4);
    }

    public void Dispose()
    {
        _instance.Dispose();
        _linked.Dispose();
    }

    [Fact]
    public void TheRepositoryStamp_MovesWithARefMovedAloneInTheRepositoryTheWorktreeIsLinkedTo()
    {
        Git("commit", "--allow-empty", "-q", "-m", "second");
        var before = _repository.RepositoryStamp();

        Git("update-ref", "refs/heads/linked", "main");

        Assert.NotEqual(before, _repository.RepositoryStamp());
    }

    [Fact]
    public void ASourceFolderLinkedToItsOwnRepository_WhoseMainIsStoredThere_IsASourceMod_AndHoldsNoOneElsesRepository()
    {
        var own = Directory.CreateDirectory(Path.Combine(_linked, "own")).FullName;
        OwnGit(own, "init", "-q", "-b", "main");
        File.WriteAllBytes(Path.Combine(own, "build.json"), SourceInits.BuildFile);
        OwnGit(own, "add", "-A");
        OwnGit(own, "commit", "-q", "-m", "The build file");

        var linked = LinkedTo(own);

        Assert.True(TestAdapters.Source().IsSourceMod(linked));
        Assert.False(TestAdapters.Source().HoldsAnotherRepository(linked));
    }

    [Fact]
    public void ASourceFolderLinkedToTheRepositoryInitMade_WithNoMain_IsASourceMod_AndHoldsNoOneElsesRepository()
    {
        var own = Path.Combine(_linked, "own");
        Assert.Null(TestAdapters.Source().Init(
            own, SourceInits.BuildFile, [OneRecordOf("A.esp")], [], commit: true, heldIn: SourceModIn.NewRepository));
        var linked = LinkedTo(own);

        OwnGit(own, "branch", "-m", "main", "renamed");

        Assert.True(TestAdapters.Source().IsSourceMod(linked));
        Assert.False(TestAdapters.Source().HoldsAnotherRepository(linked));
    }

    private string LinkedTo(string own)
    {
        var tree = Path.Combine(_linked, "own-tree");
        OwnGit(own, "worktree", "add", "-q", "-b", "linked", tree);
        return tree;
    }

    private static string OwnGit(string folder, params string[] args) => GitProbe.Run(Path.Combine(folder, ".git"), folder, args);

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_instance, ".git"), _instance, args);
}
