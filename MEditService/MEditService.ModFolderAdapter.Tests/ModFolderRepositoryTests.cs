using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;

namespace MEditService.ModFolderAdapter.Tests;

public sealed class ModFolderRepositoryTests : IDisposable
{
    private const string HashOfHello = "o22fiH2CxyY=";
    private const string HashOfHelloWithACapitalO = "0RePZfC1RR4=";

    private readonly ScratchDirectory _root = new("modfolder-adapter-");
    private readonly ScratchDirectory _statCache = new("stat-cache-");
    private readonly ModFolderRepository _repository = new(new FakeTimeProvider(TimeProvider.System.GetUtcNow().AddDays(1)));

    public void Dispose()
    {
        _root.Dispose();
        _statCache.Dispose();
    }

    [Fact]
    public void Files_ListsEveryFileByForwardSlashPath_HashedAsWabbajackHashes()
    {
        Write("readme.txt", "abc");
        Write(Path.Combine("meshes", "deep", "a.nif"), "hello");

        var files = _repository.Files(_root, "mod", new HashSet<string>(), statCache: null).Files.OrderBy(f => f.Path, StringComparer.Ordinal).ToList();

        Assert.Equal(["meshes/deep/a.nif", "readme.txt"], files.Select(f => f.Path));
        Assert.Equal(HashOfHello, files[0].Hash);
    }

    [Fact]
    public void AFileWhoseStampMatchesTheLastRead_IsNotOpenedAgain()
    {
        Write("a.txt", "hello");
        Files();
        using var held = HeldOpen("a.txt");

        Assert.Equal(HashOfHello, Assert.Single(Files()).Hash);
    }

    [Theory]
    [InlineData(0, 0, 0, HashOfHelloWithACapitalO)]
    [InlineData(1, 0, 0, HashOfHello)]
    [InlineData(0, 1, 0, HashOfHello)]
    [InlineData(0, 0, 1, HashOfHello)]
    public void AFile_TakesTheStatCachesHash_OnlyWhileItsSizeModifiedTimeAndChangeTimeAreAsLastRead(
        long sizeApart, long modifiedApart, long changedApart, string hash)
    {
        var stamp = Stamped("a.txt", "hello");
        StatCacheSays(
            $"{{\"a.txt\":{{\"size\":{stamp.Size + sizeApart},\"modified\":{stamp.Modified + modifiedApart},"
            + $"\"changed\":{stamp.Changed + changedApart},\"hash\":\"{HashOfHelloWithACapitalO}\"}}}}");

        Assert.Equal(hash, Assert.Single(Files()).Hash);
    }

    [Fact]
    public void AFileChangedAsItWasRead_IsOpenedAgain_BecauseAWriteInTheSameTickLeavesItsStamp()
    {
        var stamp = Stamped("a.txt", "hello");
        new ModFolderRepository(new FakeTimeProvider(DateTimeOffset.UnixEpoch.AddTicks(stamp.Changed / 100)))
            .Files(_root, "mod", new HashSet<string>(), _statCache);
        using var held = HeldOpen("a.txt");

        Assert.Throws<IOException>(Files);
    }

    [Theory]
    [InlineData("<<<<<<< HEAD")]
    [InlineData("{\"a.txt\":null}")]
    public void AStatCacheThatCannotBeRead_VouchesForNoFile(string text)
    {
        Write("a.txt", "hello");
        StatCacheSays(text);
        using var held = HeldOpen("a.txt");

        Assert.Throws<IOException>(Files);
    }

    [Fact]
    public void AStatCacheThatCannotBeWritten_SaysWhy_AndEveryFileIsReadAllTheSame()
    {
        Write("a.txt", "hello");
        var taken = Path.Combine(_statCache, "taken");
        File.WriteAllText(taken, "a file where the stat cache's folder would be");

        var read = _repository.Files(_root, "mod", new HashSet<string>(), taken);

        Assert.Equal(HashOfHello, Assert.Single(read.Files).Hash);
        Assert.Contains(taken, read.StatCacheNotWritten, StringComparison.Ordinal);
    }

    [Fact]
    public void AModWhoseNameHoldsASlash_KeepsItsStatCacheByItsFolderName()
    {
        Write("a.txt", "hello");
        _repository.Files(_root, "Mods/Mod", new HashSet<string>(), _statCache);
        using var held = HeldOpen("a.txt");

        Assert.Equal(HashOfHello, Assert.Single(_repository.Files(_root, "Mods/Mod", new HashSet<string>(), _statCache).Files).Hash);
    }

    [Fact]
    public void AReadThatFindsEveryFileAsLastRead_LeavesTheStatCacheUntouched()
    {
        Write("a.txt", "hello");
        Files();
        var cache = Assert.Single(Directory.GetFiles(_statCache));
        var stamp = FileStamp.Of(cache);

        Files();

        Assert.Equal(stamp, FileStamp.Of(cache));
    }

    [Fact]
    public void TheStatCache_IsKeptOutsideTheModFolder()
    {
        Write("a.txt", "hello");

        Files();

        Assert.Equal(["a.txt"], Directory.GetFileSystemEntries(_root).Select(Path.GetFileName));
    }

    [Fact]
    public void AnInstallationFile_ExistsOnlyWhenItIsThere()
    {
        Write("mod.7z", "archive");

        Assert.True(_repository.InstallationFileExists(Path.Combine(_root, "mod.7z")));
        Assert.False(_repository.InstallationFileExists(Path.Combine(_root, "absent.7z")));
    }

    [Fact]
    public void AGameFile_IsOpenedByItsPathUnderTheDataFolder()
    {
        Write(Path.Combine("Data", "meshes", "a.nif"), "hello");

        using var reader = new StreamReader(_repository.OpenGameFile(Path.Combine(_root, "Data"), "meshes/a.nif"));

        Assert.Equal("hello", reader.ReadToEnd());
    }

    [Fact]
    public void Files_LeavesOutTheModsManifest_AndEachFileItIsToldTo()
    {
        Write("a.txt", "abc");
        Write("meta.ini", "abc");
        Write("mod.manifest", "{}\n");

        Assert.Equal(["a.txt"], _repository.Files(_root, "mod", new HashSet<string> { "meta.ini" }, statCache: null).Files.Select(f => f.Path));
    }

    [Fact]
    public void WriteManifest_WritesOneLinePerSourceAndFile_InPathOrder_AFileLineNamingOnlyItsProvider()
    {
        var manifest = new Manifest(
            [new ManifestSource("Mod.7z", 100, "AAAA", Source: "nexus:1:2"), new ManifestSource("Patch.zip", 7, "BBBB")],
            [new ManifestSource("Data/Game.esm", 9, "CCCC")],
            [
                new ManifestFile("z.txt", new FileProvider.NoProvider()),
                new ManifestFile("b.nif", new FileProvider.InstallationFileEntry("Patch.zip", "Data/b.nif")),
                new ManifestFile("a.nif", new FileProvider.FirstInstallationFile()),
                new ManifestFile("c.esm", new FileProvider.GameFile("Data/Game.esm")),
            ]);

        Assert.True(_repository.WriteManifest(_root, "mod", manifest));

        Assert.Equal(
            "{\"installationFile\":\"Mod.7z\",\"size\":100,\"hash\":\"AAAA\",\"source\":\"nexus:1:2\"}\n"
            + "{\"installationFile\":\"Patch.zip\",\"size\":7,\"hash\":\"BBBB\"}\n"
            + "{\"gameFile\":\"Data/Game.esm\",\"size\":9,\"hash\":\"CCCC\"}\n"
            + "{\"path\":\"a.nif\"}\n"
            + "{\"path\":\"b.nif\",\"from\":{\"installationFile\":\"Patch.zip\",\"path\":\"Data/b.nif\"}}\n"
            + "{\"path\":\"c.esm\",\"from\":{\"gameFile\":\"Data/Game.esm\"}}\n"
            + "{\"path\":\"z.txt\",\"from\":null}\n",
            File.ReadAllText(Path.Combine(_root, "mod.manifest")));
    }

    [Fact]
    public void WriteManifest_OfTheTextAlreadyThere_WritesNothing()
    {
        var manifest = new Manifest([], [], [new ManifestFile("a.txt", new FileProvider.NoProvider())]);
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
        var manifest = new Manifest([], [], [new ManifestFile("meshes/café.nif", new FileProvider.NoProvider())]);

        _repository.WriteManifest(_root, "mod", manifest);

        var bytes = File.ReadAllBytes(Path.Combine(_root, "mod.manifest"));
        Assert.Equal((byte)'{', bytes[0]);
        Assert.Contains("café", System.Text.Encoding.UTF8.GetString(bytes));
    }

    [Fact]
    public void ReadManifest_ReadsWhatWriteManifestWrote()
    {
        var manifest = new Manifest(
            [new ManifestSource("Mod.7z", 100, "AAAA", Source: "nexus:1:2"), new ManifestSource("Patch.zip", 7, "BBBB")],
            [new ManifestSource("Data/Game.esm", 9, "CCCC")],
            [
                new ManifestFile("a.nif", new FileProvider.FirstInstallationFile()),
                new ManifestFile("b.nif", new FileProvider.InstallationFileEntry("Patch.zip", "Data/b.nif")),
                new ManifestFile("c.esm", new FileProvider.GameFile("Data/Game.esm")),
                new ManifestFile("z.txt", new FileProvider.NoProvider()),
            ]);
        _repository.WriteManifest(_root, "mod", manifest);

        var read = _repository.ReadManifest(_root, "mod");

        Assert.NotNull(read);
        Assert.Equal(manifest.InstallationFiles, read.InstallationFiles);
        Assert.Equal(manifest.GameFiles, read.GameFiles);
        Assert.Equal(manifest.Files, read.Files);
    }

    [Fact]
    public void ReadManifest_OfAModWithNone_IsNull()
    {
        Write("a.txt", "abc");

        Assert.Null(_repository.ReadManifest(_root, "mod"));
        Assert.Null(_repository.ReadManifest(Path.Combine(_root, "absent"), "mod"));
    }

    [Theory]
    [InlineData("<<<<<<< HEAD")]
    [InlineData("{\"path\":7}")]
    [InlineData("{\"path\":\"a.txt\",\"from\":{\"installationFile\":\"A.zip\"}}")]
    public void ReadManifest_WithALineItCannotRead_RefusesNamingTheLine(string line)
    {
        Write("mod.manifest", "{\"path\":\"b.txt\"}\n" + line + "\n");

        var refused = Assert.Throws<InvalidDataException>(() => _repository.ReadManifest(_root, "mod"));

        Assert.Contains("line 2", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void OpenFile_ReadsTheFileAtThePathUnderTheFolder()
    {
        Write("scripts/a.pex", "bytes");

        using var content = new StreamReader(_repository.OpenFile(_root, "scripts/a.pex"));

        Assert.Equal("bytes", content.ReadToEnd());
    }

    [Theory]
    [InlineData("old archive, longer than the new one", true)]
    [InlineData("old", true)]
    [InlineData("new", false)]
    public void WriteFile_OverAFile_PutsTheStreamsBytesAtThePath_SayingWhetherItReplacedOtherBytes(string there, bool replaced)
    {
        Write("mod.ba2", there);

        Assert.Equal(replaced, _repository.WriteFile(_root, "mod.ba2", content => content.Write("new"u8)));

        Assert.Equal("new", File.ReadAllText(Path.Combine(_root, "mod.ba2")));
    }

    [Fact]
    public void WriteFile_WhereNoFileWas_PutsTheStreamsBytesThere_AndReplacedNothing()
    {
        Assert.False(_repository.WriteFile(_root, "mod.ba2", content => content.Write("new"u8)));

        Assert.Equal("new", File.ReadAllText(Path.Combine(_root, "mod.ba2")));
    }

    [Fact]
    public void WriteFile_OfTheBytesAlreadyThere_LeavesTheFileUntouched()
    {
        var stamp = Stamped("mod.ba2", "same");

        _repository.WriteFile(_root, "mod.ba2", content => content.Write("same"u8));

        Assert.Equal(stamp, FileStamp.Of(Path.Combine(_root, "mod.ba2")));
        Assert.Equal(["mod.ba2"], Directory.GetFiles(_root).Select(Path.GetFileName));
    }

    [Fact]
    public void WriteFile_IntoAFolderNotThereYet_CreatesIt()
    {
        var folder = Path.Combine(_root, "mods", "New");

        _repository.WriteFile(folder, "a.txt", content => content.Write("new"u8));

        Assert.Equal("new", File.ReadAllText(Path.Combine(folder, "a.txt")));
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

    private IReadOnlyList<HashedFile> Files() => _repository.Files(_root, "mod", new HashSet<string>(), _statCache).Files;

    private FileStream HeldOpen(string relative) =>
        new(Path.Combine(_root, relative), FileMode.Open, FileAccess.Read, FileShare.None);

    private void StatCacheSays(string text) => File.WriteAllText(Path.Combine(_statCache, Path.GetFileName(_root.Path)), text);

    private FileStamp Stamped(string relative, string text)
    {
        Write(relative, text);
        return FileStamp.Of(Path.Combine(_root, relative)) ?? throw new InvalidOperationException("The file system gave no stamp.");
    }

    private void Write(string relative, string text)
    {
        var path = Path.Combine(_root, relative);
        new FileInfo(path).Directory?.Create();
        File.WriteAllText(path, text);
    }
}
