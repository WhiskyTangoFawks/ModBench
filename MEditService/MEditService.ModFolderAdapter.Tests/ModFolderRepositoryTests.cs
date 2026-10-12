using MEditService.RepositoriesLib;
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

        var files = _repository.Files(_root, "mod").OrderBy(f => f.Path, StringComparer.Ordinal).ToList();

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

        Assert.Equal(path, described?.Path);
        Assert.Equal(7, described?.Stamp?.Size);
    }

    [Fact]
    public void AnInstallationFileThatIsNotThere_IsNull()
    {
        Assert.Null(_repository.InstallationFile(Path.Combine(_root, "absent.7z")));
    }

    [Fact]
    public void GameFile_DescribesTheFileUnderTheGameFolder_OrIsNullWhenAbsent()
    {
        Write(Path.Combine("Data", "Game.esm"), "vanilla");

        Assert.Equal(7, _repository.GameFile(_root, "Data/Game.esm")?.Stamp?.Size);
        Assert.Null(_repository.GameFile(_root, "Data/Other.esm"));
    }

    [Fact]
    public void Files_LeavesOutTheModsManifest()
    {
        Write("a.txt", "abc");
        Write("mod.manifest", "{}\n");

        Assert.Equal(["a.txt"], _repository.Files(_root, "mod").Select(f => f.Path));
    }

    [Fact]
    public void WriteManifest_WritesOneLinePerSourceAndFile_InPathOrder()
    {
        var stamp = new FileStamp(5, 1234, 99);
        var manifest = new Manifest(
            [new ManifestSource("Mod.7z", 100, "AAAA", Source: "nexus:1:2"), new ManifestSource("Patch.zip", 7, "BBBB")],
            [new ManifestSource("Data/Game.esm", 9, "CCCC")],
            [
                new ManifestFile("z.txt", "H3", stamp, new FileProvider.NoProvider()),
                new ManifestFile("b.nif", "H2", stamp, new FileProvider.InstallationFileEntry("Patch.zip", "Data/b.nif")),
                new ManifestFile("a.nif", "H1", stamp, new FileProvider.FirstInstallationFile()),
                new ManifestFile("c.esm", "H4", null, new FileProvider.GameFile("Data/Game.esm")),
            ]);

        Assert.True(_repository.WriteManifest(_root, "mod", manifest));

        Assert.Equal(
            "{\"installationFile\":\"Mod.7z\",\"size\":100,\"hash\":\"AAAA\",\"source\":\"nexus:1:2\"}\n"
            + "{\"installationFile\":\"Patch.zip\",\"size\":7,\"hash\":\"BBBB\"}\n"
            + "{\"gameFile\":\"Data/Game.esm\",\"size\":9,\"hash\":\"CCCC\"}\n"
            + "{\"path\":\"a.nif\",\"hash\":\"H1\",\"size\":5,\"modified\":1234}\n"
            + "{\"path\":\"b.nif\",\"hash\":\"H2\",\"size\":5,\"modified\":1234,\"from\":{\"installationFile\":\"Patch.zip\",\"path\":\"Data/b.nif\"}}\n"
            + "{\"path\":\"c.esm\",\"hash\":\"H4\",\"from\":{\"gameFile\":\"Data/Game.esm\"}}\n"
            + "{\"path\":\"z.txt\",\"hash\":\"H3\",\"size\":5,\"modified\":1234,\"from\":null}\n",
            File.ReadAllText(Path.Combine(_root, "mod.manifest")));
    }

    [Fact]
    public void WriteManifest_OfTheTextAlreadyThere_WritesNothing()
    {
        var manifest = new Manifest([], [], [new ManifestFile("a.txt", "H", null, new FileProvider.NoProvider())]);
        _repository.WriteManifest(_root, "mod", manifest);
        var path = Path.Combine(_root, "mod.manifest");
        var longAgo = new DateTime(2001, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        File.SetLastWriteTimeUtc(path, longAgo);

        Assert.False(_repository.WriteManifest(_root, "mod", manifest));

        Assert.Equal(longAgo, File.GetLastWriteTimeUtc(path));
    }

    [Fact]
    public void WriteManifest_WritesNoByteOrderMark_AndKeepsANonAsciiNameReadable()
    {
        var manifest = new Manifest([], [], [new ManifestFile("meshes/café.nif", "H", null, new FileProvider.NoProvider())]);

        _repository.WriteManifest(_root, "mod", manifest);

        var bytes = File.ReadAllBytes(Path.Combine(_root, "mod.manifest"));
        Assert.Equal((byte)'{', bytes[0]);
        Assert.Contains("café", System.Text.Encoding.UTF8.GetString(bytes));
    }

    [Fact]
    public void WriteFile_PutsTheStreamsBytesAtThePath_ReplacingWhatWasThere()
    {
        Write("mod.ba2", "old archive, longer than the new one");

        _repository.WriteFile(_root, "mod.ba2", content => content.Write("new"u8));

        Assert.Equal("new", File.ReadAllText(Path.Combine(_root, "mod.ba2")));
    }

    [Fact]
    public void WriteFile_CreatesTheFoldersOfThePath()
    {
        _repository.WriteFile(_root, "archives/mod.ba2", content => content.Write("new"u8));

        Assert.Equal("new", File.ReadAllText(Path.Combine(_root, "archives", "mod.ba2")));
    }

    [Fact]
    public void WriteFile_WhenTheWriteThrows_LeavesTheFolderAsItWas()
    {
        Write("mod.ba2", "old");

        Assert.Throws<InvalidDataException>(() => _repository.WriteFile(_root, "mod.ba2", content =>
        {
            content.Write("half"u8);
            throw new InvalidDataException("cannot");
        }));

        Assert.Equal("old", File.ReadAllText(Path.Combine(_root, "mod.ba2")));
        Assert.Equal(["mod.ba2"], Directory.GetFiles(_root).Select(Path.GetFileName));
    }

    [Fact]
    public void WriteFile_WhileWriting_HoldsTheBytesInAHiddenFileOfNoModExtension()
    {
        string[] during = [];

        _repository.WriteFile(_root, "mod.ba2", content =>
        {
            content.Write("new"u8);
            during = [.. Directory.GetFiles(_root).Select(Path.GetFileName).OfType<string>()];
        });

        var held = Assert.Single(during);
        Assert.StartsWith(".medit_tmp_", held);
        Assert.EndsWith(".tmp", held);
    }

    [Fact]
    public void WriteFile_WhenTheWriteThrows_CreatesNoFolderForThePath()
    {
        Assert.Throws<InvalidDataException>(() => _repository.WriteFile(_root, "archives/mod.ba2", _ => throw new InvalidDataException("cannot")));

        Assert.Empty(Directory.GetFileSystemEntries(_root));
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
