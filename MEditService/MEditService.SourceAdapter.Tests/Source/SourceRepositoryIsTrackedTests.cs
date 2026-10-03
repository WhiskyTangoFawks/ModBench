using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryIsTrackedTests : IDisposable
{
    private readonly ScratchDirectory _modFolder = new("medit-istracked-");

    public void Dispose() => _modFolder.Dispose();

    [Fact]
    public void IsTracked_FolderWithNoGitDirectory_IsFalse()
    {
        Assert.False(SourceRepository.IsTracked(_modFolder));
    }

    [Fact]
    public void IsTracked_RepositoryWithNoMain_IsFalse()
    {
        Git("init", "-q", "-b", "main");

        Assert.False(SourceRepository.IsTracked(_modFolder));
    }

    [Fact]
    public void IsTracked_RepositoryWithMain_IsTrue()
    {
        CommitOnMain();

        Assert.True(SourceRepository.IsTracked(_modFolder));
    }

    [Fact]
    public void IsTracked_RepositoryWhoseMainGitPacked_IsTrue()
    {
        CommitOnMain();
        Git("pack-refs", "--all");

        Assert.False(File.Exists(Path.Combine(_modFolder, ".git", "refs", "heads", "main")));
        Assert.True(SourceRepository.IsTracked(_modFolder));
    }

    [Fact]
    public void IsTracked_FolderGoneSinceTheLoadedModsWereListed_IsFalseNotAThrow()
    {
        Assert.False(SourceRepository.IsTracked(Path.Combine(_modFolder, "Gone")));
    }

    private void CommitOnMain()
    {
        Git("init", "-q", "-b", "main");
        Git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "--allow-empty", "-m", "First");
    }

    private void Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);
}
