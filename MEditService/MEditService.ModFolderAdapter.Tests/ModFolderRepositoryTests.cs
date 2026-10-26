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
    private readonly ScratchDirectory _source = new("source-");
    private readonly ModFolderRepository _repository = new(new FakeTimeProvider(TimeProvider.System.GetUtcNow().AddDays(1)));

    public void Dispose()
    {
        _root.Dispose();
        _statCache.Dispose();
        _source.Dispose();
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
    public void ExcludedName_IsTheNameWithTheExclusionMarkAfterIt() =>
        Assert.Equal("a.esp.excluded", _repository.ExcludedName("a.esp", ".excluded"));

    [Fact]
    public void DataFolderExists_AnswersWhetherTheFolderIsThere()
    {
        Assert.True(_repository.DataFolderExists(_root));
        Assert.False(_repository.DataFolderExists(Path.Combine(_root, "no-such-data")));
    }

    [Fact]
    public void ALeftoverOfAKilledWrite_IsNoFileOfTheMod()
    {
        Write("a.txt", "hello");
        TempLeftover.DeadWriters(_root);
        Write(Path.Combine(".medit_tmp_1_dir", "mod.esp"), "half");

        Assert.Equal(["a.txt"], _repository.Files(_root, "mod", new HashSet<string>(), statCache: null).Files.Select(f => f.Path));
        Assert.Equal(["a.txt"], _repository.FilePaths(_root));
        Assert.Equal(["a.txt"], _repository.NamedByNoLine(_root, "mod", NoLines, new HashSet<string>()));
    }

    public static TheoryData<string, Func<string, string>, bool> Leftovers => new()
    {
        { "a file whose writer is gone", TempLeftover.DeadWriters, false },
        { "a folder whose writer is gone", folder => Directory.CreateDirectory(Path.Combine(folder, ".medit_tmp_2000000000_dir")).FullName, false },
        { "a file whose writer runs", TempLeftover.RunningWriters, true },
        { "a file whose name carries no writer", folder => WrittenAt(Path.Combine(folder, ".medit_tmp_nowriter.tmp")), true },
    };

    [Theory]
    [MemberData(nameof(Leftovers))]
    public void AWrite_RemovesALeftover_OnlyWhenItsWriterIsGone(string _, Func<string, string> leftoverIn, bool kept)
    {
        var leftover = leftoverIn(_root);

        _repository.WriteFile(_root, "mod.ba2", content => content.Write("new"u8));

        Assert.Equal(kept, Path.Exists(leftover));
    }

    private static string WrittenAt(string path)
    {
        File.WriteAllText(path, "half");
        return path;
    }

    [Fact]
    public void AWrite_WhoseLeftoverCannotBeRemoved_Fails()
    {
        using var stuck = TempLeftover.Undeletable(_root);

        Assert.ThrowsAny<SystemException>(() => _repository.WriteFile(_root, "mod.ba2", content => content.Write("new"u8)));
        Assert.False(File.Exists(Path.Combine(_root, "mod.ba2")));
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
    public void AToolsRewriteThatKeepsSizeAndModifiedTime_IsHashedAgain()
    {
        Write("a.txt", "hello");
        File.SetLastWriteTimeUtc(Path.Combine(_root, "a.txt"), LongAgo);
        Files();
        AfterTheSystemClockNtfsStampsAChangeWithTicks();

        Write("a.txt", "hellO");
        File.SetLastWriteTimeUtc(Path.Combine(_root, "a.txt"), LongAgo);

        Assert.Equal(HashOfHelloWithACapitalO, Assert.Single(Files()).Hash);
    }

    private static void AfterTheSystemClockNtfsStampsAChangeWithTicks()
    {
        var tick = Environment.TickCount64;
        SpinWait.SpinUntil(() => Environment.TickCount64 != tick);
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

        var status = repository.Status(_root, "mod", new HashSet<string>(), _statCache, held: null, sourceFolder: null);

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

        Assert.Equal(differing is null ? [] : [differing], repository.Status(_root, "mod", new HashSet<string>(), _statCache, held: null, sourceFolder: null).Differing);
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
    public void AManifest_IsNamedForTheMod_WithTheJsonSuffix()
    {
        _repository.WriteManifest(_root, "mod", new Manifest(null, []));

        Assert.Equal(["mod.manifest.json"], Directory.GetFiles(_root).Select(Path.GetFileName));
    }

    [Fact]
    public void AManifestThatNamesNothing_IsWritten_ReadBack_AndAgreesWithAFolderOfItsMetadataAlone()
    {
        Write("meta.ini", "[General]");
        var nothing = new Manifest(null, []);

        var written = _repository.WriteManifest(_root, "mod", nothing);
        var writtenAgain = _repository.WriteManifest(_root, "mod", nothing);

        Assert.Equal([true, false, true], [written, writtenAgain, File.Exists(Path.Combine(_root, "mod.manifest.json"))]);
        var read = Assert.IsType<Manifest>(_repository.ReadManifest(_root, "mod"));
        Assert.Empty(read.Files);
        Assert.Null(read.Package);
        Assert.Equal(new ModStatus("mod", NoManifest: false, [], [], [], [], []), Status());
    }

    [Fact]
    public void AfterAFreshClone_EveryFileTheManifestNamesIsGone_AndNoneDiffersOrIsNamedByNoLine()
    {
        Write("meta.ini", "[General]");
        Manifested(Line("a.nif", "Mod.zip"));

        var status = Status();

        Assert.Equal(new ModStatus("mod", NoManifest: false, [], [], ["a.nif"], [], []), status);
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
    [InlineData("Mod", false)]
    [InlineData("Other", true)]
    public void AFileItsSourceModBuilds_Differs_UnlessItHoldsTheBytesTheLastBuildOfTheManifestsRepositoryKept(string repository, bool differs)
    {
        Write("a.esp", "hello");
        KeepAsRestored(ManifestedFromSource("Mod"));
        ManifestedFromSource(repository);

        Assert.Equal(differs, SourceModStatus().Differing.Contains("a.esp"));
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
    public void AFileItsPackageDoesNotHold_IsNotInThePackage_AndDoesNotDiffer()
    {
        Write("a.nif", "edited");
        Manifested(new ManifestFile("a.nif", new PackageEntry.NotHeld()));

        var status = Status();

        Assert.Equal(["a.nif"], status.NotInPackage);
        Assert.Empty(status.Differing);
    }

    [Fact]
    public void AFileItsPackageHoldsWithOtherBytes_IsInItsOwnList_NotInThePackageList_AndDoesNotDiffer()
    {
        Write("a.nif", "edited");
        Write("b.nif", "added");
        Manifested(new ManifestFile("a.nif", new PackageEntry.OtherBytes()), new ManifestFile("b.nif", new PackageEntry.NotHeld()));

        var status = Status();

        Assert.Equal(["b.nif"], status.NotInPackage);
        Assert.Equal(["a.nif"], status.OtherBytes);
        Assert.Empty(status.Differing);
    }

    [Fact]
    public void AFileAStepMakes_IsNoGapAndDoesNotDiffer_ButIsGoneWhenTheFolderLacksIt()
    {
        Write("made.dds", "whatever the step wrote");
        ManifestFile[] madeByStep = [new("made.dds", new PackageEntry.MadeByStep()), new("lacked.dds", new PackageEntry.MadeByStep())];
        _repository.WriteManifest(_root, "mod", new Manifest(Package, madeByStep) { Steps = [new ManifestStep("Optimise textures", [])] });

        var status = Status();

        Assert.Empty(status.NotInPackage);
        Assert.Empty(status.Differing);
        Assert.Equal(["lacked.dds"], status.Gone);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public void ASourceMod_HasNoHost_OnlyWhenItsRepositoryIsNoSubmodule_AndItsPackageHoldsEveryFile(bool isSubmodule, bool noHost)
    {
        Write("a.esp", "hello");
        ManifestedFromSource("Mod", isSubmodule);

        var status = SourceModStatus();

        Assert.Equal((noHost, 0), (status.NoHost, status.NotInPackage.Count));
    }

    [Fact]
    public void ASourceModsStatus_ReadsTheManifestInItsRepository_NotOneInItsFolder()
    {
        Write("a.esp", "hello");
        Write("notes.txt", "mine");
        Manifested(Line("notes.txt", "Mod.zip"));
        ManifestedFromSource("Mod");

        var status = SourceModStatus();

        Assert.False(status.NoManifest);
        Assert.Equal(["notes.txt"], status.NamedByNoLine);
    }

    [Fact]
    public void ASourceModWhoseRepositoryHoldsNoManifest_HasNoManifest()
    {
        Write("a.esp", "hello");
        Manifested(Line("a.esp", "Mod.zip"));

        Assert.True(SourceModStatus().NoManifest);
    }

    [Fact]
    public void AModWithNoManifest_HasNoManifest_AndListsNothing()
    {
        Write("mine.txt", "mine");

        Assert.Equal(new ModStatus("mod", NoManifest: true, [], [], [], [], []), Status());
    }

    [Fact]
    public void AModWithAManifestItCannotRead_IsUnreadable_NamingTheLine_AndListsNothing()
    {
        Write("mine.txt", "mine");
        Write("mod.manifest.json", "<<<<<<< HEAD\n");

        var status = Status();

        Assert.True(status.Unreadable?.Manifest);
        Assert.Contains("line 1", status.Unreadable?.Why, StringComparison.Ordinal);
        Assert.Equal(new ModStatus("mod", NoManifest: false, [], [], [], [], []), status with { Unreadable = null });
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
        Write("mod.manifest.json", "{}\n");

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
                new ManifestFile("y.esp", new PackageEntry.OtherBytes()),
                ManifestFile.At("b.nif", new FileBytes.InInstallationFile("Mod.7z", "Data/b.nif")),
                new ManifestFile("a.nif", new PackageEntry.Held()),
            ],
            "1.2.3");

        Assert.True(_repository.WriteManifest(_root, "mod", manifest));

        var text = File.ReadAllText(Path.Combine(_root, "mod.manifest.json"));
        Assert.Equal(
            "{\n"
            + "\"package\": {\"installationFile\":\"Mod.7z\",\"size\":100,\"hash\":\"AAAA\",\"page\":\"https://www.nexusmods.com/fallout4/mods/1\",\"version\":\"1.2.3\"},\n"
            + "\"files\": [\n"
            + "{\"path\":\"a.nif\"},\n"
            + "{\"path\":\"b.nif\",\"packagePath\":\"Data/b.nif\"},\n"
            + "{\"path\":\"y.esp\",\"otherBytes\":true},\n"
            + "{\"path\":\"z.txt\",\"inPackage\":false}\n"
            + "]\n"
            + "}\n",
            text);
        using var parsed = JsonDocument.Parse(text);
        Assert.Equal(4, parsed.RootElement.GetProperty("files").GetArrayLength());
    }

    [Fact]
    public void WriteManifest_WritesALineForEachStep_InTheOrderTheyRun_AndSaysWhichFileAStepMakes()
    {
        var manifest = new Manifest(Package, [new ManifestFile("textures/a.dds", new PackageEntry.MadeByStep()), new ManifestFile("a.nif", new PackageEntry.Held())])
        {
            Steps = [new ManifestStep("Optimise textures", ["--in", "textures"]), new ManifestStep("Archive", [])],
        };

        _repository.WriteManifest(_root, "mod", manifest);

        Assert.Equal(
            "{\n"
            + "\"package\": {\"installationFile\":\"Mod.7z\",\"size\":100,\"hash\":\"AAAA\",\"page\":\"https://www.nexusmods.com/fallout4/mods/1\"},\n"
            + "\"steps\": [\n"
            + "{\"task\":\"Optimise textures\",\"args\":[\"--in\",\"textures\"]},\n"
            + "{\"task\":\"Archive\"}\n"
            + "],\n"
            + "\"files\": [\n"
            + "{\"path\":\"a.nif\"},\n"
            + "{\"path\":\"textures/a.dds\",\"madeByStep\":true}\n"
            + "]\n"
            + "}\n",
            File.ReadAllText(Path.Combine(_root, "mod.manifest.json")));
    }

    public static TheoryData<ManifestPackage, string> PackagesAndTheirLines => new()
    {
        { new ManifestPackage.SourceRepository("Mod", IsSubmodule: true), "{\"submodule\":\"Mod\",\"version\":\"2\"}" },
        { new ManifestPackage.SourceRepository("Mod", IsSubmodule: false), "{\"repository\":\"Mod\",\"version\":\"2\"}" },
        { new ManifestPackage.GameFolder("Fallout 4", "AAAA"), "{\"gameFolder\":\"Fallout 4\",\"hash\":\"AAAA\",\"version\":\"2\"}" },
    };

    [Theory]
    [MemberData(nameof(PackagesAndTheirLines))]
    public void WriteManifest_NamesTheModsPackageByItsKind_WithTheVersion(ManifestPackage package, string line)
    {
        _repository.WriteManifest(_root, "mod", new Manifest(package, [new ManifestFile("d.esp", new PackageEntry.Held())], "2"));

        Assert.Contains("\"package\": " + line, File.ReadAllText(Path.Combine(_root, "mod.manifest.json")));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("1.2.3")]
    public void WriteManifest_OfAModWithNoPackageAndNoFiles_WritesAnEmptyFileList_BecauseTheVersionBelongsToThePackage(string? version)
    {
        _repository.WriteManifest(_root, "mod", new Manifest(null, [], version));

        Assert.Equal("{\n\"files\": []\n}\n", File.ReadAllText(Path.Combine(_root, "mod.manifest.json")));
    }

    [Fact]
    public void WriteManifest_OfTheTextAlreadyThere_WritesNothing()
    {
        var manifest = new Manifest(null, [new ManifestFile("a.txt", new PackageEntry.NotHeld())]);
        _repository.WriteManifest(_root, "mod", manifest);
        var path = Path.Combine(_root, "mod.manifest.json");
        File.SetLastWriteTimeUtc(path, LongAgo);

        Assert.False(_repository.WriteManifest(_root, "mod", manifest));

        Assert.Equal(LongAgo, File.GetLastWriteTimeUtc(path));
    }

    [Fact]
    public void WriteManifest_WritesNoByteOrderMark_AndKeepsANonAsciiNameReadable()
    {
        var manifest = new Manifest(null, [new ManifestFile("meshes/café.nif", new PackageEntry.NotHeld())]);

        _repository.WriteManifest(_root, "mod", manifest);

        var bytes = File.ReadAllBytes(Path.Combine(_root, "mod.manifest.json"));
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
        new Manifest(new ManifestPackage.SourceRepository("Mod", IsSubmodule: true), [new ManifestFile("d.esp", new PackageEntry.Held())], "2"),
        new Manifest(new ManifestPackage.SourceRepository("Mod", IsSubmodule: false), [new ManifestFile("d.esp", new PackageEntry.Held())]),
        new Manifest(new ManifestPackage.GameFolder("Fallout 4", "AAAA"), [new ManifestFile("d.esp", new PackageEntry.Held())], "2"),
        new Manifest(null, []),
        new Manifest(new ManifestPackage.InstallationFile("Mod.7z", 100, "AAAA"), [new ManifestFile("a.esp", new PackageEntry.OtherBytes())]),
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
    public void ReadManifest_ReadsTheStepsWriteManifestWrote_InTheirOrder_AndTheFilesTheyMake()
    {
        _repository.WriteManifest(_root, "mod", new Manifest(null, [new ManifestFile("b.dds", new PackageEntry.MadeByStep())])
        {
            Steps = [new ManifestStep("Zip", ["a", "b"]), new ManifestStep("Archive", [])],
        });

        var read = _repository.ReadManifest(_root, "mod");

        Assert.NotNull(read);
        Assert.Equal([("Zip", "a|b"), ("Archive", "")], read.Steps.Select(step => (step.Task, string.Join('|', step.Args))));
        Assert.Equal([new ManifestFile("b.dds", new PackageEntry.MadeByStep())], read.Files);
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
    [InlineData("{\"files\": [{\"path\":\"a.txt\",\"otherBytes\":false}]}", "its file 1: its otherBytes is false")]
    [InlineData("{\"files\": [{\"path\":\"a.txt\",\"inPackage\":true}]}", "its file 1: its inPackage is true")]
    [InlineData("{\"files\": [{\"path\":\"a.txt\",\"inPackage\":false,\"otherBytes\":true}]}", "its file 1: it says both")]
    [InlineData("{\"files\": [{\"path\":\"a.txt\",\"otherBytes\":true,\"packagePath\":\"b.txt\"}]}", "its file 1: it names a path")]
    [InlineData("{\"files\": [{\"path\":\"a.txt\",\"inPackage\":false,\"packagePath\":\"b.txt\"}]}", "its file 1: it names a path")]
    [InlineData("{\"files\": []", "line")]
    [InlineData("{\"package\": {\"installationFile\":\"A.zip\"}, \"files\": []}", "cannot be read")]
    [InlineData("{\"package\": {\"remote\":\"https://example.com/mod.git\"}, \"files\": []}", "holds 'remote'")]
    [InlineData("{\"package\": {\"version\": 7}, \"files\": []}", "cannot be read")]
    [InlineData("{}", "cannot be read")]
    [InlineData("{\"steps\": [{\"task\":\"Zip\"}], \"files\": [{\"path\":\"a.txt\",\"madeByStep\":false}]}", "its file 1: its madeByStep is false")]
    [InlineData("{\"steps\": [{\"task\":\"Zip\"}], \"files\": [{\"path\":\"a.txt\",\"madeByStep\":true,\"otherBytes\":true}]}", "its file 1: it says both")]
    [InlineData("{\"steps\": [{\"task\":\"Zip\"}], \"files\": [{\"path\":\"a.txt\",\"madeByStep\":true,\"inPackage\":false}]}", "its file 1: it says both")]
    [InlineData("{\"steps\": [{\"task\":\"Zip\"}], \"files\": [{\"path\":\"a.txt\",\"madeByStep\":true,\"packagePath\":\"b.txt\"}]}", "its file 1: it names a path")]
    [InlineData("{\"files\": [{\"path\":\"a.txt\",\"madeByStep\":true}]}", "its file 1: it says a step makes the file, and the manifest holds no step")]
    [InlineData("{\"steps\": [{\"task\":\"\"}], \"files\": []}", "its manifest cannot be read at its step 1: it names no task")]
    [InlineData("{\"steps\": [{\"args\":[\"a\"]}], \"files\": []}", "its manifest cannot be read at its step 1")]
    [InlineData("{\"steps\": [{\"task\":\"Zip\",\"args\":[1]}], \"files\": []}", "its manifest cannot be read at its step 1")]
    public void ReadManifest_WithTextItCannotRead_RefusesNamingWhere(string text, string where)
    {
        Write("mod.manifest.json", text);

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
    [InlineData("mod.ba2", "old archive, longer than the new one", true)]
    [InlineData("mod.ba2", "old", true)]
    [InlineData("mod.ba2", "new", false)]
    [InlineData("another.ba2", "old", false)]
    public void WriteFile_PutsTheStreamsBytesAtThePath_SayingWhetherItReplacedOtherBytes(string pathThere, string there, bool replaced)
    {
        Write(pathThere, there);

        Assert.Equal(replaced, _repository.WriteFile(_root, "mod.ba2", content => content.Write("new"u8)));

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

    [Theory]
    [InlineData("mods/New", "a.txt")]
    [InlineData("", "archives/mod.ba2")]
    public void WriteFile_CreatesTheFoldersItNeeds(string folder, string path)
    {
        _repository.WriteFile(Path.Combine(_root, folder), path, content => content.Write("new"u8));

        Assert.Equal("new", File.ReadAllText(Path.Combine(_root, folder, path)));
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

    private Manifest Manifested((string Path, string InstallationFile) line) => Manifested(line.InstallationFile, [new ManifestFile(line.Path, new PackageEntry.Held())]);

    private Manifest Manifested(params ManifestFile[] lines) => Manifested("Mod.zip", lines);

    private Manifest Manifested(string installationFile, ManifestFile[] lines)
    {
        var manifest = new Manifest(new ManifestPackage.InstallationFile(installationFile, 7, "#" + installationFile), lines);
        _repository.WriteManifest(_root, "mod", manifest);
        return manifest;
    }

    private Manifest ManifestedFromSource(string repository, bool isSubmodule = true)
    {
        var manifest = new Manifest(new ManifestPackage.SourceRepository(repository, isSubmodule), [new ManifestFile("a.esp", new PackageEntry.Held())]) { Output = "mod" };
        _repository.WriteSourceManifest(_source, manifest);
        return manifest;
    }

    private ModStatus SourceModStatus() => _repository.Status(_root, "mod", new HashSet<string> { "meta.ini" }, _statCache, held: null, _source);

    private void KeepAsRestored(Manifest manifest) =>
        _repository.KeepInStatCache(
            _repository.Files(_root, "mod", new HashSet<string>(), _statCache), manifest,
            manifest.Files.ToDictionary(line => line.Path, _ => HashOfHello));

    private ModStatus Status() => _repository.Status(_root, "mod", new HashSet<string> { "meta.ini" }, _statCache, held: null, sourceFolder: null);

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
