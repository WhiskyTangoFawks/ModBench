namespace MEditService.ModFolderAdapter.Tests;

public sealed class ModFolderRepositoryTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("modfolder-adapter-").FullName;
    private static readonly DateTime Stamp = new(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    private readonly ModFolderRepository _repository = new();

    public void Dispose() => Directory.Delete(_root, recursive: true);

    [Fact]
    public void Files_ListsEveryFileByForwardSlashPathWithItsSizeAndModifiedTime()
    {
        var modified = Stamp.AddSeconds(5);
        Write("readme.txt", "abc", modified);
        Write(Path.Combine("meshes", "deep", "a.nif"), "hello", modified);

        var files = _repository.Files(_root).OrderBy(f => f.Path, StringComparer.Ordinal).ToList();

        Assert.Equal(
            [new ModFile("meshes/deep/a.nif", 5, modified), new ModFile("readme.txt", 3, modified)],
            files);
    }

    [Fact]
    public void OpenFile_ReadsTheBytesOfAFileUnderTheModFolder()
    {
        Write(Path.Combine("meshes", "a.nif"), "hello", Stamp);

        using var content = _repository.OpenFile(_root, "meshes/a.nif");

        Assert.Equal("hello", ReadAll(content));
    }

    [Fact]
    public void OpenInstallationFile_ReadsTheBytesOfTheNamedFile()
    {
        Write("mod.7z", "archive", Stamp);

        using var content = _repository.OpenInstallationFile(Path.Combine(_root, "mod.7z"));

        Assert.Equal("archive", ReadAll(content));
    }

    [Fact]
    public void InstallationFile_DescribesTheNamedFileWithoutReadingIt()
    {
        var modified = Stamp.AddSeconds(5);
        Write("mod.7z", "archive", modified);
        var path = Path.Combine(_root, "mod.7z");

        Assert.Equal(new ModFile(path, 7, modified), _repository.InstallationFile(path));
    }

    private void Write(string relative, string text, DateTime modified)
    {
        var path = Path.Combine(_root, relative);
        new FileInfo(path).Directory?.Create();
        File.WriteAllText(path, text);
        File.SetLastWriteTimeUtc(path, modified);
    }

    private static string ReadAll(Stream content)
    {
        using var reader = new StreamReader(content);
        return reader.ReadToEnd();
    }
}
