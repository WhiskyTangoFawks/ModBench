using MEditService.TestSupport;

namespace MEditService.ModFolderAdapter.Tests;

public sealed class ModFolderRepositoryTests : IDisposable
{
    private readonly ScratchDirectory _root = new("modfolder-adapter-");
    private readonly ModFolderRepository _repository = new();

    public void Dispose() => _root.Dispose();

    [Fact]
    public void Files_ListsEveryFileByForwardSlashPathWithItsSize()
    {
        Write("readme.txt", "abc");
        Write(Path.Combine("meshes", "deep", "a.nif"), "hello");

        var files = _repository.Files(_root).OrderBy(f => f.Path, StringComparer.Ordinal).ToList();

        Assert.Equal(["meshes/deep/a.nif", "readme.txt"], files.Select(f => f.Path));
        Assert.Equal([5L, 3L], files.Select(f => f.Stamp?.Size));
    }

    [Fact]
    public void OpenFile_ReadsTheBytesOfAFileUnderTheModFolder()
    {
        Write(Path.Combine("meshes", "a.nif"), "hello");

        using var content = _repository.OpenFile(_root, "meshes/a.nif");

        Assert.Equal("hello", ReadAll(content));
    }

    [Fact]
    public void OpenInstallationFile_ReadsTheBytesOfTheNamedFile()
    {
        Write("mod.7z", "archive");

        using var content = _repository.OpenInstallationFile(Path.Combine(_root, "mod.7z"));

        Assert.Equal("archive", ReadAll(content));
    }

    [Fact]
    public void InstallationFile_DescribesTheNamedFileWithoutReadingIt()
    {
        Write("mod.7z", "archive");
        var path = Path.Combine(_root, "mod.7z");

        var described = _repository.InstallationFile(path);

        Assert.Equal(path, described.Path);
        Assert.Equal(7, described.Stamp?.Size);
    }

    private void Write(string relative, string text)
    {
        var path = Path.Combine(_root, relative);
        new FileInfo(path).Directory?.Create();
        File.WriteAllText(path, text);
    }

    private static string ReadAll(Stream content)
    {
        using var reader = new StreamReader(content);
        return reader.ReadToEnd();
    }
}
