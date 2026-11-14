namespace MEditService.TestSupport;

public sealed class RunFolderTests
{
    private const string Name = "medit-run-folder-test";

    [Fact]
    public void AWrite_ClearsWhatAKilledRunLeftThere()
    {
        var leftover = Path.Combine(Path.GetTempPath(), Name, "leftover.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(leftover).Require());
        File.WriteAllText(leftover, "a killed run's");

        using var folder = RunFolder.Written(Name, path => File.WriteAllText(Path.Combine(path, "written.txt"), "this run's"));

        Assert.False(File.Exists(leftover));
        Assert.True(File.Exists(Path.Combine(folder.Path, "written.txt")));
    }

    [Fact]
    public void AWriteThatThrows_LeavesNoFolder()
    {
        Assert.Throws<InvalidOperationException>(() => RunFolder.Written(Name, path =>
        {
            File.WriteAllText(Path.Combine(path, "partway.txt"), "x");
            throw new InvalidOperationException("The write failed part-way.");
        }));

        Assert.False(Directory.Exists(Path.Combine(Path.GetTempPath(), Name)));
    }

    [Fact]
    public void Dispose_RemovesTheFolder()
    {
        var folder = RunFolder.Written(Name, path => File.WriteAllText(Path.Combine(path, "written.txt"), "x"));

        folder.Dispose();

        Assert.False(Directory.Exists(folder.Path));
    }
}
