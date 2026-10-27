using System.Text;

namespace MEditService.ModFolderAdapter.Tests;

public sealed class ScratchFilesTests
{
    [Fact]
    public void AStoredContent_IsReadAgainFromItsStart_EachTimeItIsOpened()
    {
        using var scratch = new ScratchFiles();

        var stored = scratch.Store(new MemoryStream(Encoding.UTF8.GetBytes("hello")));

        Assert.Equal(["hello", "hello"], [ReadAll(stored), ReadAll(stored)]);
    }

    [Fact]
    public void ADisposedScratch_HoldsNoContent()
    {
        var scratch = new ScratchFiles();
        var stored = scratch.Store(new MemoryStream(Encoding.UTF8.GetBytes("hello")));

        scratch.Dispose();

        Assert.ThrowsAny<IOException>(() => stored());
    }

    private static string ReadAll(Func<Stream> open)
    {
        using var content = new StreamReader(open());
        return content.ReadToEnd();
    }
}
