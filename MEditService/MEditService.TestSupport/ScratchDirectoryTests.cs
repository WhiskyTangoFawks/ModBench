namespace MEditService.TestSupport;

public sealed class ScratchDirectoryTests
{
    [Fact]
    public void Dispose_RemovesTheDirectoryAndItsContents()
    {
        var scratch = new ScratchDirectory("medit-scratch-test-");
        File.WriteAllText(Path.Combine(scratch, "file.txt"), "x");

        scratch.Dispose();

        Assert.False(Directory.Exists(scratch));
    }

    [Fact]
    public void Dispose_AfterTheDirectoryIsGone_DoesNotThrow()
    {
        var scratch = new ScratchDirectory("medit-scratch-test-");
        Directory.Delete(scratch);

        scratch.Dispose();
    }
}
