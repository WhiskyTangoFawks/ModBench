using System.Text.Json;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;

namespace MEditService.ModFolderAdapter.Tests;

public sealed class ModFolderRepositoryTests : IDisposable
{
    private const string HashOfHello = "o22fiH2CxyY=";
    private const string HashOfHelloWithACapitalO = "0RePZfC1RR4=";

    private static readonly DateTime LongAgo = new(2001, 1, 1, 0, 0, 0, DateTimeKind.Utc);

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
        Write("a.txt", "hello");
        Files();
        var read = StatCacheEntries()["a.txt"];
        StatCacheSays(new Dictionary<string, CachedEntry>
        {
            ["a.txt"] = new(read.Size + sizeApart, read.Modified + modifiedApart, read.Changed + changedApart, HashOfHelloWithACapitalO),
        });

        Assert.Equal(hash, Assert.Single(Files()).Hash);
    }

    [Fact]
    public void AFileChangedAsItWasRead_IsOpenedAgain_BecauseAWriteInTheSameTickLeavesItsStamp()
    {
        Write("a.txt", "hello");
        var unsettled = new ModFolderRepository(new FakeTimeProvider(File.GetLastWriteTimeUtc(Path.Combine(_root, "a.txt"))));
        unsettled.KeepInStatCache(unsettled.Files(_root, "mod", new HashSet<string>(), _statCache), NoLines, NoHashes);
        using var held = HeldOpen("a.txt");

        Assert.Throws<IOException>(Files);
    }

    [Theory]
    [InlineData("<<<<<<< HEAD")]
    [InlineData("{\"files\":{\"a.txt\":null}}")]
    [InlineData("{\"files\":null}")]
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
        Assert.Contains(taken, _repository.KeepInStatCache(read, NoLines, NoHashes), StringComparison.Ordinal);
    }

    [Fact]
    public void AModWhoseNameHoldsASlash_KeepsItsStatCacheByItsFolderName()
    {
        Write("a.txt", "hello");
        _repository.KeepInStatCache(_repository.Files(_root, "Mods/Mod", new HashSet<string>(), _statCache), NoLines, NoHashes);
        using var held = HeldOpen("a.txt");

        Assert.Equal(HashOfHello, Assert.Single(_repository.Files(_root, "Mods/Mod", new HashSet<string>(), _statCache).Files).Hash);
    }

    [Fact]
    public void AReadThatFindsEveryFileAsLastRead_LeavesTheStatCacheUntouched()
    {
        Write("a.txt", "hello");
        Files();
        File.SetLastWriteTimeUtc(StatCacheFile, LongAgo);

        Files();

        Assert.Equal(LongAgo, File.GetLastWriteTimeUtc(StatCacheFile));
    }

    [Fact]
    public void TheStatCache_IsKeptOutsideTheModFolder()
    {
        Write("a.txt", "hello");

        Files();

        Assert.Equal(["a.txt"], Directory.GetFileSystemEntries(_root).Select(Path.GetFileName));
    }

    [Fact]
    public void Status_NamesEachFileNoLineNames_ButTheManifestAndEachFileLeftOut()
    {
        Write("mine.txt", "mine");
        Write("meta.ini", "[General]");
        Write("a.nif", "hello");
        KeepAsRestored(Manifested(Line("a.nif", "Mod.zip")));

        var status = Status();

        Assert.Equal(["mine.txt"], status.NamedByNoLine);
        Assert.Empty(status.Differing);
    }

    private Func<string, bool> FileSystemMatchingNames(StringComparison comparison) =>
        path => Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories)
            .Any(file => string.Equals(Normalized(file), Normalized(path), comparison));

    private static string Normalized(string path) => path.Replace('\\', '/');

    [Theory]
    [InlineData(StringComparison.OrdinalIgnoreCase, false)]
    [InlineData(StringComparison.Ordinal, true)]
    public void AFileNamedByALineInAnotherCase_IsNamedByNoLine_OnlyWhereTheFileSystemFindsItByTheLinesName(
        StringComparison fileSystemMatchesNames, bool namedByNoLine)
    {
        Write("Meshes/A.nif", "hello");
        var manifest = Manifested(Line("meshes/a.nif", "Mod.zip"));
        var repository = new ModFolderRepository(
            TimeProvider.System,
            FileSystemMatchingNames(fileSystemMatchesNames));

        var status = repository.Status(_root, "mod", new HashSet<string>(), _statCache);

        Assert.Equal(namedByNoLine, repository.NamedByNoLine(_root, "mod", manifest, new HashSet<string>()).Contains("Meshes/A.nif"));
        Assert.Equal(namedByNoLine, status.NamedByNoLine.Contains("Meshes/A.nif"));
        Assert.Equal(namedByNoLine, status.Gone.Contains("meshes/a.nif"));
    }

    [Theory]
    [InlineData(StringComparison.OrdinalIgnoreCase, "Meshes/A.nif")]
    [InlineData(StringComparison.Ordinal, null)]
    public void AFileThatDiffers_IsNamedByItsPathOnDisk_WhereTheFileSystemFindsItByItsLinesName(
        StringComparison fileSystemMatchesNames, string? differing)
    {
        Write("Meshes/A.nif", "hello");
        Manifested(Line("meshes/a.nif", "Mod.zip"));
        var repository = new ModFolderRepository(
            TimeProvider.System,
            FileSystemMatchingNames(fileSystemMatchesNames));

        Assert.Equal(differing is null ? [] : [differing], repository.Status(_root, "mod", new HashSet<string>(), _statCache).Differing);
    }

    [PosixFact]
    public void AStatusWhoseStatCacheCannotBeWritten_SaysWhy()
    {
        Write("a.nif", "hello");
        KeepAsRestored(Manifested(Line("a.nif", "Mod.zip")));
        Write("a.nif", "hello");
        FileModes.Set(_statCache, "555");
        try
        {
            Assert.Contains(_statCache.Path, Status().StatCacheNotWritten, StringComparison.Ordinal);
        }
        finally
        {
            FileModes.Set(_statCache, "755");
        }
    }

    [PosixFact]
    public void OnAFileSystemThatTellsCaseApart_TwoFilesWhoseNamesDifferInCaseAlone_AreOneNamedByALineAndOneNot()
    {
        Write("a.nif", "hello");
        Write("A.nif", "hello");
        var manifest = Manifested(Line("a.nif", "Mod.zip"));

        Assert.Equal(["A.nif"], _repository.NamedByNoLine(_root, "mod", manifest, new HashSet<string>()));
    }

    [Fact]
    public void AManifestThatNamesNothing_IsWritten_ReadBack_AndAgreesWithAFolderOfItsMetadataAlone()
    {
        Write("meta.ini", "[General]");
        var nothing = new Manifest(null, []);

        var written = _repository.WriteManifest(_root, "mod", nothing);
        var writtenAgain = _repository.WriteManifest(_root, "mod", nothing);

        Assert.Equal([true, false, true], [written, writtenAgain, File.Exists(Path.Combine(_root, "mod.manifest"))]);
        var read = Assert.IsType<Manifest>(_repository.ReadManifest(_root, "mod"));
        Assert.Empty(read.Files);
        Assert.Null(read.Package);
        Assert.Equal(new ModStatus("mod", NoManifest: false, [], [], [], []), Status());
    }

    [Fact]
    public void AfterAFreshClone_EveryFileTheManifestNamesIsGone_AndNoneDiffersOrIsNamedByNoLine()
    {
        Write("meta.ini", "[General]");
        Manifested(Line("a.nif", "Mod.zip"));

        var status = Status();

        Assert.Equal(new ModStatus("mod", NoManifest: false, [], [], ["a.nif"], []), status);
    }

    [Fact]
    public void AFileALineNames_AsTheLastRestoreKeptIt_DoesNotDiffer()
    {
        Write("a.nif", "hello");
        KeepAsRestored(Manifested(Line("a.nif", "Mod.zip")));

        Assert.Empty(Status().Differing);
    }

    [Theory]
    [InlineData("hello", "Mod.zip", false)]
    [InlineData("edited", "Mod.zip", true)]
    [InlineData("hello", "Upgraded.zip", true)]
    public void AFileALineNames_WrittenSinceTheLastRestore_Differs_UnlessItHoldsTheBytesItsPackageFixed(
        string written, string installationFile, bool differs)
    {
        Write("a.nif", "hello");
        KeepAsRestored(Manifested(Line("a.nif", "Mod.zip")));
        Write("a.nif", written);
        Manifested(Line("a.nif", installationFile));

        Assert.Equal(differs, Status().Differing.Contains("a.nif"));
    }

    [Theory]
    [InlineData("0123abc", false)]
    [InlineData("4567def", true)]
    public void AFileItsSourceModBuilds_Differs_UnlessItHoldsTheBytesTheBuildAtTheLinesCommitKept(string commit, bool differs)
    {
        Write("a.esp", "hello");
        KeepAsRestored(ManifestedFromSource("0123abc"));
        ManifestedFromSource(commit);

        Assert.Equal(differs, Status().Differing.Contains("a.esp"));
    }

    [Fact]
    public void AStatus_KeepsWhatItReadInTheStatCache_SoTheNextOpensNoFileItRead()
    {
        Write("a.nif", "hello");
        KeepAsRestored(Manifested(Line("a.nif", "Mod.zip")));
        Write("a.nif", "hello");
        Status();
        using var held = HeldOpen("a.nif");

        Assert.Empty(Status().Differing);
    }

    [Fact]
    public void AStatus_KeepsTheHashItsPackageFixes_AsTheStatCacheHeldIt()
    {
        Write("a.nif", "hello");
        KeepAsRestored(Manifested(Line("a.nif", "Mod.zip")));

        Status();

        Assert.Empty(Status().Differing);
    }

    [Fact]
    public void AFileALineNamesThatIsGone_IsGone_AndDoesNotDiffer()
    {
        Manifested(Line("a.nif", "Mod.zip"));

        var status = Status();

        Assert.Equal(["a.nif"], status.Gone);
        Assert.Empty(status.Differing);
    }

    [Fact]
    public void AFileItsPackageDoesNotHold_IsNotInThePackage_AndDoesNotDiffer()
    {
        Write("a.nif", "edited");
        Manifested(new ManifestFile("a.nif", new PackageEntry.NotHeld()));

        var status = Status();

        Assert.Equal(["a.nif"], status.NotInPackage);
        Assert.Empty(status.Differing);
    }

    [Fact]
    public void AModWithNoManifest_HasNoManifest_AndListsNothing()
    {
        Write("mine.txt", "mine");

        Assert.Equal(new ModStatus("mod", NoManifest: true, [], [], [], []), Status());
    }

    [Fact]
    public void AModWithAManifestItCannotRead_IsUnreadable_NamingTheLine_AndListsNothing()
    {
        Write("mine.txt", "mine");
        Write("mod.manifest", "<<<<<<< HEAD\n");

        var status = Status();

        Assert.True(status.Unreadable?.Manifest);
        Assert.Contains("line 1", status.Unreadable?.Why, StringComparison.Ordinal);
        Assert.Equal(new ModStatus("mod", NoManifest: false, [], [], [], []), status with { Unreadable = null });
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

        Assert.Equal(["a.txt"], _repository.Files(_root, "mod", new HashSet<string> { "meta.ini" }, statCache: null).Files.Select(f => f.Path));
    }

    private static readonly ManifestPackage.InstallationFile Package = new("Mod.7z", 100, "AAAA", "https://www.nexusmods.com/fallout4/mods/1");

    [Fact]
    public void WriteManifest_WritesAJsonFileWithALineForThePackageWithItsVersionAndOneForEachFile_InPathOrder()
    {
        var manifest = new Manifest(
            Package,
            [
                new ManifestFile("z.txt", new PackageEntry.NotHeld()),
                ManifestFile.At("b.nif", new FileBytes.InInstallationFile("Mod.7z", "Data/b.nif")),
                new ManifestFile("a.nif", new PackageEntry.Held()),
            ],
            "1.2.3");

        Assert.True(_repository.WriteManifest(_root, "mod", manifest));

        var text = File.ReadAllText(Path.Combine(_root, "mod.manifest"));
        Assert.Equal(
            "{\n"
            + "\"package\": {\"installationFile\":\"Mod.7z\",\"size\":100,\"hash\":\"AAAA\",\"page\":\"https://www.nexusmods.com/fallout4/mods/1\",\"version\":\"1.2.3\"},\n"
            + "\"files\": [\n"
            + "{\"path\":\"a.nif\"},\n"
            + "{\"path\":\"b.nif\",\"packagePath\":\"Data/b.nif\"},\n"
            + "{\"path\":\"z.txt\",\"inPackage\":false}\n"
            + "]\n"
            + "}\n",
            text);
        using var parsed = JsonDocument.Parse(text);
        Assert.Equal(3, parsed.RootElement.GetProperty("files").GetArrayLength());
    }

    [Fact]
    public void WriteManifest_OfASourceMod_NamesItsRemoteAndCommitAsItsPackage()
    {
        _repository.WriteManifest(_root, "mod", new Manifest(
            new ManifestPackage.SourceMod("https://example.com/mod.git", "0123abc"), [new ManifestFile("d.esp", new PackageEntry.Held())]));

        Assert.Contains(
            "\"package\": {\"remote\":\"https://example.com/mod.git\",\"commit\":\"0123abc\"}", File.ReadAllText(Path.Combine(_root, "mod.manifest")));
    }

    [Fact]
    public void WriteManifest_OfAModWithAVersionAndNoPackage_HoldsTheVersionOnThePackageLine()
    {
        _repository.WriteManifest(_root, "mod", new Manifest(null, [], "1.2.3"));

        Assert.Equal("{\n\"package\": {\"version\":\"1.2.3\"},\n\"files\": []\n}\n", File.ReadAllText(Path.Combine(_root, "mod.manifest")));
        Assert.Equal("1.2.3", _repository.ReadManifest(_root, "mod")?.Version);
    }

    [Fact]
    public void WriteManifest_OfAModWithNoPackageAndNoFiles_WritesAnEmptyFileList()
    {
        _repository.WriteManifest(_root, "mod", new Manifest(null, []));

        Assert.Equal("{\n\"files\": []\n}\n", File.ReadAllText(Path.Combine(_root, "mod.manifest")));
    }

    [Fact]
    public void WriteManifest_OfTheTextAlreadyThere_WritesNothing()
    {
        var manifest = new Manifest(null, [new ManifestFile("a.txt", new PackageEntry.NotHeld())]);
        _repository.WriteManifest(_root, "mod", manifest);
        var path = Path.Combine(_root, "mod.manifest");
        File.SetLastWriteTimeUtc(path, LongAgo);

        Assert.False(_repository.WriteManifest(_root, "mod", manifest));

        Assert.Equal(LongAgo, File.GetLastWriteTimeUtc(path));
    }

    [Fact]
    public void WriteManifest_WritesNoByteOrderMark_AndKeepsANonAsciiNameReadable()
    {
        var manifest = new Manifest(null, [new ManifestFile("meshes/café.nif", new PackageEntry.NotHeld())]);

        _repository.WriteManifest(_root, "mod", manifest);

        var bytes = File.ReadAllBytes(Path.Combine(_root, "mod.manifest"));
        Assert.Equal((byte)'{', bytes[0]);
        Assert.Contains("café", System.Text.Encoding.UTF8.GetString(bytes));
    }

    [Fact]
    public void WriteManifest_OrdersFilesAlphabetically_NotCapitalsFirst()
    {
        var manifest = new Manifest(null, [
            new ManifestFile("Textures/x.dds", new PackageEntry.Held()),
            new ManifestFile("meshes/b.nif", new PackageEntry.Held()),
            new ManifestFile("Meshes/a.nif", new PackageEntry.Held()),
            new ManifestFile("meshes/a.nif", new PackageEntry.Held()),
        ]);

        _repository.WriteManifest(_root, "mod", manifest);

        Assert.Equal(
            ["Meshes/a.nif", "meshes/a.nif", "meshes/b.nif", "Textures/x.dds"],
            _repository.ReadManifest(_root, "mod")?.Files.Select(file => file.Path));
    }

    public static TheoryData<Manifest> Manifests => new()
    {
        new Manifest(
            Package,
            [
                new ManifestFile("a.nif", new PackageEntry.Held()),
                ManifestFile.At("b.nif", new FileBytes.InInstallationFile("Mod.7z", "Data/b.nif")),
                new ManifestFile("z.txt", new PackageEntry.NotHeld()),
            ],
            "1.2.3"),
        new Manifest(new ManifestPackage.InstallationFile("Mod.7z", 100, "AAAA"), [new ManifestFile("a.nif", new PackageEntry.Held())]),
        new Manifest(new ManifestPackage.SourceMod("https://example.com/mod.git", "0123abc"), [new ManifestFile("d.esp", new PackageEntry.Held())]),
        new Manifest(null, []),
    };

    [Theory]
    [MemberData(nameof(Manifests))]
    public void ReadManifest_ReadsWhatWriteManifestWrote(Manifest manifest)
    {
        _repository.WriteManifest(_root, "mod", manifest);

        var read = _repository.ReadManifest(_root, "mod");

        Assert.NotNull(read);
        Assert.Equal(manifest.Package, read.Package);
        Assert.Equal(manifest.Version, read.Version);
        Assert.Equal(manifest.Files, read.Files);
    }

    [Fact]
    public void AManifestWithoutAVersion_WritesNoVersionLine()
    {
        _repository.WriteManifest(_root, "mod", new Manifest(null, [new ManifestFile("a.nif", new PackageEntry.NotHeld())]));

        Assert.DoesNotContain("version", File.ReadAllText(Path.Combine(_root, "mod.manifest")));
    }

    [Fact]
    public void ReadManifest_OfAModWithNone_IsNull()
    {
        Write("a.txt", "abc");

        Assert.Null(_repository.ReadManifest(_root, "mod"));
        Assert.Null(_repository.ReadManifest(Path.Combine(_root, "absent"), "mod"));
    }

    [Theory]
    [InlineData("<<<<<<< HEAD\n", "line 1")]
    [InlineData("{\n\"files\": [\n{\"path\":\"a.txt\"}\n{\"path\":\"b.txt\"}\n]\n}\n", "line 4")]
    [InlineData("{\"files\": [{\"path\":\"a.txt\"},{\"path\":7}]}", "its file 2")]
    [InlineData("{\"files\": [{\"path\":\"a.txt\"},{\"path\":\"b.txt\",\"packagePath\":7}]}", "its file 2")]
    [InlineData("{\"files\": []", "line")]
    [InlineData("{\"package\": {\"installationFile\":\"A.zip\"}, \"files\": []}", "cannot be read")]
    [InlineData("{\"package\": {\"remote\":\"https://example.com/mod.git\"}, \"files\": []}", "cannot be read")]
    [InlineData("{\"package\": {\"version\": 7}, \"files\": []}", "cannot be read")]
    [InlineData("{}", "cannot be read")]
    public void ReadManifest_WithTextItCannotRead_RefusesNamingWhere(string text, string where)
    {
        Write("mod.manifest", text);

        var refused = Assert.Throws<InvalidDataException>(() => _repository.ReadManifest(_root, "mod"));

        Assert.Contains(where, refused.Message, StringComparison.Ordinal);
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
        Write("mod.ba2", "same");
        File.SetLastWriteTimeUtc(Path.Combine(_root, "mod.ba2"), LongAgo);

        _repository.WriteFile(_root, "mod.ba2", content => content.Write("same"u8));

        Assert.Equal(LongAgo, File.GetLastWriteTimeUtc(Path.Combine(_root, "mod.ba2")));
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

    private static readonly Manifest NoLines = new(null, []);

    private static readonly Dictionary<string, string> NoHashes = [];

    private IReadOnlyList<HashedFile> Files()
    {
        var read = _repository.Files(_root, "mod", new HashSet<string>(), _statCache);
        _repository.KeepInStatCache(read, NoLines, NoHashes);
        return read.Files;
    }

    private static (string Path, string InstallationFile) Line(string path, string installationFile) => (path, installationFile);

    private Manifest Manifested((string Path, string InstallationFile) line) => Manifested(line.InstallationFile, new ManifestFile(line.Path, new PackageEntry.Held()));

    private Manifest Manifested(ManifestFile line) => Manifested("Mod.zip", line);

    private Manifest Manifested(string installationFile, ManifestFile line)
    {
        var manifest = new Manifest(new ManifestPackage.InstallationFile(installationFile, 7, "#" + installationFile), [line]);
        _repository.WriteManifest(_root, "mod", manifest);
        return manifest;
    }

    private Manifest ManifestedFromSource(string commit)
    {
        var manifest = new Manifest(new ManifestPackage.SourceMod("https://example.com/mod.git", commit), [new ManifestFile("a.esp", new PackageEntry.Held())]);
        _repository.WriteManifest(_root, "mod", manifest);
        return manifest;
    }

    private void KeepAsRestored(Manifest manifest) =>
        _repository.KeepInStatCache(
            _repository.Files(_root, "mod", new HashSet<string>(), _statCache), manifest,
            manifest.Files.ToDictionary(line => line.Path, _ => HashOfHello));

    private ModStatus Status() => _repository.Status(_root, "mod", new HashSet<string> { "meta.ini" }, _statCache);

    private FileStream HeldOpen(string relative) =>
        new(Path.Combine(_root, relative), FileMode.Open, FileAccess.Read, FileShare.None);

    private sealed record CachedEntry(long Size, long Modified, long Changed, string Hash);

    private string StatCacheFile => Path.Combine(_statCache, Path.GetFileName(_root.Path));

    private sealed record CachedFiles(Dictionary<string, CachedEntry> Files);

    private Dictionary<string, CachedEntry> StatCacheEntries() =>
        JsonSerializer.Deserialize<CachedFiles>(File.ReadAllText(StatCacheFile), JsonSerializerOptions.Web)?.Files ?? [];

    private void StatCacheSays(Dictionary<string, CachedEntry> entries) =>
        StatCacheSays(JsonSerializer.Serialize(new CachedFiles(entries), JsonSerializerOptions.Web));

    private void StatCacheSays(string text) => File.WriteAllText(StatCacheFile, text);

    private void Write(string relative, string text)
    {
        var path = Path.Combine(_root, relative);
        new FileInfo(path).Directory?.Create();
        File.WriteAllText(path, text);
    }
}
