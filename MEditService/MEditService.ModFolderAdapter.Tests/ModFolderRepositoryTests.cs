using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;

namespace MEditService.ModFolderAdapter.Tests;

public sealed class ModFolderRepositoryTests : IDisposable
{
    private const string HashOfHello = "o22fiH2CxyY=";
    private const string HashOfHelloWithACapitalO = "0RePZfC1RR4=";

    private readonly ScratchDirectory _root = new("modfolder-adapter-");
    private readonly ModFolderRepository _repository = new(new FakeTimeProvider(TimeProvider.System.GetUtcNow().AddDays(1)));

    public void Dispose() => _root.Dispose();

    [Fact]
    public void Files_ListsEveryFileByForwardSlashPath_HashedAsWabbajackHashes()
    {
        Write("readme.txt", "abc");
        Write(Path.Combine("meshes", "deep", "a.nif"), "hello");

        var files = _repository.Files(_root, "mod", new HashSet<string>(), NoHashes).OrderBy(f => f.Path, StringComparer.Ordinal).ToList();

        Assert.Equal(["meshes/deep/a.nif", "readme.txt"], files.Select(f => f.Path));
        Assert.Equal(HashOfHello, files[0].Hash);
    }

    [Fact]
    public void AFileWhoseSizeAndTimeMatchItsManifestLine_TakesTheHashItsProviderNames()
    {
        var stamp = Stamped("a.txt", "hello");
        _repository.WriteManifest(_root, "mod", Manifest(new ManifestFile("a.txt", stamp, new FileProvider.FirstInstallationFile())));

        Assert.Equal(HashOfHelloWithACapitalO, OnlyFile(("a.txt", HashOfHelloWithACapitalO)).Hash);
    }

    [Fact]
    public void AFileWhoseSizeAndTimeMatchItsManifestLine_WhoseProviderNamesNoHash_IsHashed()
    {
        var stamp = Stamped("a.txt", "hello");
        _repository.WriteManifest(_root, "mod", Manifest(new ManifestFile("a.txt", stamp, new FileProvider.NoProvider())));

        Assert.Equal(HashOfHello, OnlyFile(("b.txt", HashOfHelloWithACapitalO)).Hash);
    }

    [Theory]
    [InlineData(1, 0)]
    [InlineData(0, 1)]
    public void AFileWhoseSizeOrTimeDiffersFromItsManifestLine_IsHashed(long sizeApart, long modifiedApart)
    {
        var stamp = Stamped("a.txt", "hello");
        var line = stamp with { Size = stamp.Size + sizeApart, Modified = stamp.Modified + modifiedApart };
        _repository.WriteManifest(_root, "mod", Manifest(new ManifestFile("a.txt", line, new FileProvider.FirstInstallationFile())));

        Assert.Equal(HashOfHello, OnlyFile(("a.txt", HashOfHelloWithACapitalO)).Hash);
    }

    [Fact]
    public void AFileWhoseManifestLineHasNoStamp_IsHashed()
    {
        Write("a.txt", "hello");
        _repository.WriteManifest(_root, "mod", Manifest(new ManifestFile("a.txt", null, new FileProvider.FirstInstallationFile())));

        Assert.Equal(HashOfHello, OnlyFile(("a.txt", HashOfHelloWithACapitalO)).Hash);
    }

    [Fact]
    public void AManifestWithLinesThatAreNotJson_StillLetsEachFileBeHashed()
    {
        Write("a.txt", "hello");
        Write("mod.manifest", "<<<<<<< HEAD\n{\"path\":\"a.txt\",\"size\":5\n=======\n>>>>>>> theirs\n");

        Assert.Equal(HashOfHello, OnlyFile(("a.txt", HashOfHelloWithACapitalO)).Hash);
    }

    [Fact]
    public void AFileChangedLongBeforeItWasRead_CarriesItsStamp()
    {
        var stamp = Stamped("a.txt", "hello");

        Assert.Equal(stamp, OnlyFile().Stamp);
    }

    [Fact]
    public void AFileChangedAsItWasRead_CarriesNoStamp_BecauseAWriteInTheSameTickLeavesItsStamp()
    {
        var stamp = Stamped("a.txt", "hello");
        var readAtTheChange = new ModFolderRepository(new FakeTimeProvider(DateTimeOffset.UnixEpoch.AddTicks(stamp.Changed / 100)));

        Assert.Null(Assert.Single(readAtTheChange.Files(_root, "mod", new HashSet<string>(), NoHashes)).Stamp);
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

        Assert.Equal(["a.txt"], _repository.Files(_root, "mod", new HashSet<string> { "meta.ini" }, NoHashes).Select(f => f.Path));
    }

    [Fact]
    public void WriteManifest_WritesOneLinePerSourceAndFile_InPathOrder_AFileLineCarryingNoHash()
    {
        var stamp = new FileStamp(5, 1234, 99);
        var manifest = new Manifest(
            [new ManifestSource("Mod.7z", 100, "AAAA", Source: "nexus:1:2"), new ManifestSource("Patch.zip", 7, "BBBB")],
            [new ManifestSource("Data/Game.esm", 9, "CCCC")],
            [
                new ManifestFile("z.txt", stamp, new FileProvider.NoProvider()),
                new ManifestFile("b.nif", stamp, new FileProvider.InstallationFileEntry("Patch.zip", "Data/b.nif")),
                new ManifestFile("a.nif", stamp, new FileProvider.FirstInstallationFile()),
                new ManifestFile("c.esm", null, new FileProvider.GameFile("Data/Game.esm")),
            ]);

        Assert.True(_repository.WriteManifest(_root, "mod", manifest));

        Assert.Equal(
            "{\"installationFile\":\"Mod.7z\",\"size\":100,\"hash\":\"AAAA\",\"source\":\"nexus:1:2\"}\n"
            + "{\"installationFile\":\"Patch.zip\",\"size\":7,\"hash\":\"BBBB\"}\n"
            + "{\"gameFile\":\"Data/Game.esm\",\"size\":9,\"hash\":\"CCCC\"}\n"
            + "{\"path\":\"a.nif\",\"size\":5,\"modified\":1234}\n"
            + "{\"path\":\"b.nif\",\"size\":5,\"modified\":1234,\"from\":{\"installationFile\":\"Patch.zip\",\"path\":\"Data/b.nif\"}}\n"
            + "{\"path\":\"c.esm\",\"from\":{\"gameFile\":\"Data/Game.esm\"}}\n"
            + "{\"path\":\"z.txt\",\"size\":5,\"modified\":1234,\"from\":null}\n",
            File.ReadAllText(Path.Combine(_root, "mod.manifest")));
    }

    [Fact]
    public void WriteManifest_OfTheTextAlreadyThere_WritesNothing()
    {
        var manifest = new Manifest([], [], [new ManifestFile("a.txt", null, new FileProvider.NoProvider())]);
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
        var manifest = new Manifest([], [], [new ManifestFile("meshes/café.nif", null, new FileProvider.NoProvider())]);

        _repository.WriteManifest(_root, "mod", manifest);

        var bytes = File.ReadAllBytes(Path.Combine(_root, "mod.manifest"));
        Assert.Equal((byte)'{', bytes[0]);
        Assert.Contains("café", System.Text.Encoding.UTF8.GetString(bytes));
    }

    [Fact]
    public void ReadManifest_ReadsWhatWriteManifestWrote_WithoutTheStampsOnlyFilesTrusts()
    {
        var stamp = new FileStamp(5, 1234, 99);
        var manifest = new Manifest(
            [new ManifestSource("Mod.7z", 100, "AAAA", Source: "nexus:1:2"), new ManifestSource("Patch.zip", 7, "BBBB")],
            [new ManifestSource("Data/Game.esm", 9, "CCCC")],
            [
                new ManifestFile("a.nif", stamp, new FileProvider.FirstInstallationFile()),
                new ManifestFile("b.nif", stamp, new FileProvider.InstallationFileEntry("Patch.zip", "Data/b.nif")),
                new ManifestFile("c.esm", null, new FileProvider.GameFile("Data/Game.esm")),
                new ManifestFile("z.txt", stamp, new FileProvider.NoProvider()),
            ]);
        _repository.WriteManifest(_root, "mod", manifest);

        var read = _repository.ReadManifest(_root, "mod");

        Assert.NotNull(read);
        Assert.Equal(manifest.InstallationFiles, read.InstallationFiles);
        Assert.Equal(manifest.GameFiles, read.GameFiles);
        Assert.Equal(manifest.Files.Select(file => file with { Stamp = null }), read.Files);
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

    private static Manifest Manifest(params ManifestFile[] files) => new([], [], files);

    private static readonly Dictionary<string, string> NoHashes = [];

    private HashedFile OnlyFile(params (string Path, string Hash)[] provided) =>
        Assert.Single(_repository.Files(_root, "mod", new HashSet<string>(), provided.ToDictionary(p => p.Path, p => p.Hash)));

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
