using MEditService.SourceRepo;

namespace MEditService.Tests.Source;

/// <summary>Tracked is the presence of <c>.git</c> in the mod folder and nothing broader
/// (ADR-0007): a folder that merely exists is not tracked.</summary>
public sealed class SourceRepositoryIsTrackedTests
{
    [Fact]
    public void IsTracked_FolderWithNoGitDirectory_IsFalse()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-istracked-").FullName;
        try
        {
            Assert.False(SourceRepository.IsTracked(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void IsTracked_FolderWithGitDirectory_IsTrue()
    {
        var modFolder = Directory.CreateTempSubdirectory("medit-istracked-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(modFolder, ".git"));
            Assert.True(SourceRepository.IsTracked(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void IsTracked_FolderThatDoesNotExistAtAll_IsFalseNotAThrow()
    {
        var root = Directory.CreateTempSubdirectory("medit-istracked-root-").FullName;
        try
        {
            // Never-assume-exclusive-ownership: the folder can vanish between "which mods are
            // loaded" and "which are tracked" — a missing folder reads as untracked, never a throw.
            Assert.False(SourceRepository.IsTracked(Path.Combine(root, "Gone")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
