using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;

namespace MEditService.ModFolderAdapter.Tests;

public sealed class ModFolderRepositoryTests : IDisposable
{
    private const string HashOfHello = "o22fiH2CxyY=";

    private readonly ScratchDirectory _root = new("modfolder-adapter-");
    private readonly ModFolderRepository _repository = new(new FakeTimeProvider(TimeProvider.System.GetUtcNow().AddDays(1)));

    public void Dispose() => _root.Dispose();

    [Fact]
    public void Files_ListsEveryFileByForwardSlashPath_HashedAsWabbajackHashes()
    {
        Write("readme.txt", "abc");
        Write(Path.Combine("meshes", "deep", "a.nif"), "hello");

        var files = _repository.Files(_root, "mod", new HashSet<string>()).OrderBy(f => f.Path, StringComparer.Ordinal).ToList();

        Assert.Equal(["meshes/deep/a.nif", "readme.txt"], files.Select(f => f.Path));
        Assert.Equal(HashOfHello, files[0].Hash);
    }

    [Fact]
    public void AFileWhoseSizeAndTimeMatchItsManifestLine_KeepsTheLinesHash()
    {
        var stamp = Stamped("a.txt", "hello");
        _repository.WriteManifest(_root, "mod", Manifest(new ManifestFile("a.txt", "LINE", stamp, new FileProvider.NoProvider())));

        Assert.Equal("LINE", OnlyFile().Hash);
    }

    [Theory]
    [InlineData(1, 0)]
    [InlineData(0, 1)]
    public void AFileWhoseSizeOrTimeDiffersFromItsManifestLine_IsHashed(long sizeApart, long modifiedApart)
    {
        var stamp = Stamped("a.txt", "hello");
        var line = stamp with { Size = stamp.Size + sizeApart, Modified = stamp.Modified + modifiedApart };
        _repository.WriteManifest(_root, "mod", Manifest(new ManifestFile("a.txt", "LINE", line, new FileProvider.NoProvider())));

        Assert.Equal(HashOfHello, OnlyFile().Hash);
    }

    [Fact]
    public void AFileWhoseManifestLineHasNoStamp_IsHashed()
    {
        Write("a.txt", "hello");
        _repository.WriteManifest(_root, "mod", Manifest(new ManifestFile("a.txt", "LINE", null, new FileProvider.NoProvider())));

        Assert.Equal(HashOfHello, OnlyFile().Hash);
    }

    [Fact]
    public void AManifestWithLinesThatAreNotJson_StillLetsEachFileBeHashed()
    {
        Write("a.txt", "hello");
        Write("mod.manifest", "<<<<<<< HEAD\n{\"path\":\"a.txt\",\"hash\":\"LINE\"\n=======\n>>>>>>> theirs\n");

        Assert.Equal(HashOfHello, OnlyFile().Hash);
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

        Assert.Null(Assert.Single(readAtTheChange.Files(_root, "mod", new HashSet<string>())).Stamp);
    }

    [Fact]
    public void AnInstallationFile_ExistsOnlyWhenItIsThere()
    {
        Write("mod.7z", "archive");

        Assert.True(_repository.InstallationFileExists(Path.Combine(_root, "mod.7z")));
        Assert.False(_repository.InstallationFileExists(Path.Combine(_root, "absent.7z")));
    }

    [Fact]
    public void Files_LeavesOutTheModsManifest_AndEachFileItIsToldTo()
    {
        Write("a.txt", "abc");
        Write("meta.ini", "abc");
        Write("mod.manifest", "{}\n");

        Assert.Equal(["a.txt"], _repository.Files(_root, "mod", new HashSet<string> { "meta.ini" }).Select(f => f.Path));
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

    private static Manifest Manifest(params ManifestFile[] files) => new([], [], files);

    private HashedFile OnlyFile() => Assert.Single(_repository.Files(_root, "mod", new HashSet<string>()));

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
