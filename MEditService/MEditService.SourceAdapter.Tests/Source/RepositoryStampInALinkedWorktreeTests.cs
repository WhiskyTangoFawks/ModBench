using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.SourceAdapter.Tests.TestSupport.PluginBaselines;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class RepositoryStampInALinkedWorktreeTests : IDisposable
{
    private readonly ScratchDirectory _instance = new("medit-linked-main-");
    private readonly ScratchDirectory _linked = new("medit-linked-worktree-");
    private readonly ISourceRepository _repository;

    public RepositoryStampInALinkedWorktreeTests()
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

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_instance, ".git"), _instance, args);
}
