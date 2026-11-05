using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class StampGatedMemoTests : IDisposable
{
    private readonly ScratchDirectory _folder = new("stamp-gated-memo");

    private string FilePath => Path.Combine(_folder.Path, "Kept.bin");

    public void Dispose() => _folder.Dispose();

    [Fact]
    public void AnUnchangedFile_IsReadOnce_AndAChangedOneAgain()
    {
        var reads = 0;
        var memo = new StampGatedMemo<object>(new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1)));
        object Read()
        {
            reads++;
            return new object();
        }
        File.WriteAllBytes(FilePath, [1]);

        memo.Of(FilePath, Read);
        memo.Of(FilePath, Read);
        File.WriteAllBytes(FilePath, [1, 2]);
        memo.Of(FilePath, Read);

        Assert.Equal(2, reads);
    }

    [Fact]
    public void AFileWhoseChangeTimeMoved_ButNotItsSizeOrDateModified_IsNotReadAgain()
    {
        var reads = 0;
        var memo = new StampGatedMemo<object>(new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1)));
        object Read()
        {
            reads++;
            return new object();
        }
        File.WriteAllBytes(FilePath, [1]);

        memo.Of(FilePath, Read);
        File.SetAttributes(FilePath, FileAttributes.ReadOnly);
        File.SetAttributes(FilePath, FileAttributes.Normal);
        memo.Of(FilePath, Read);

        Assert.Equal(1, reads);
    }
}
