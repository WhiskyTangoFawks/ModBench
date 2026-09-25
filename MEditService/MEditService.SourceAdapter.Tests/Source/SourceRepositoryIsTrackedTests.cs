using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>Tracked is a repository in the mod folder whose <c>main</c> exists, and nothing broader
/// (ADR-0007): a folder that merely exists, or a <c>.git</c> a failed Track left, is not tracked.</summary>
public sealed class SourceRepositoryIsTrackedTests : IDisposable
{
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-istracked-").FullName;

    public void Dispose() => Directory.Delete(_modFolder, recursive: true);

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
    public void IsTracked_FolderThatDoesNotExistAtAll_IsFalseNotAThrow()
    {
        // Never-assume-exclusive-ownership: the folder can vanish between "which mods are
        // loaded" and "which are tracked" — a missing folder reads as untracked, never a throw.
        Assert.False(SourceRepository.IsTracked(Path.Combine(_modFolder, "Gone")));
    }

    private void CommitOnMain()
    {
        Git("init", "-q", "-b", "main");
        Git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "--allow-empty", "-m", "First");
    }

    private void Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);
}
