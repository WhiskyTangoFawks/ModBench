using System.Text.Json;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;

namespace MEditService.ModFolderAdapter.Tests;

public sealed class ModFolderRepositoryTests : IDisposable
{
    private const string HashOfHello = "o22fiH2CxyY=";
    private const string HashOfHelloWithACapitalO = "0RePZfC1RR4=";

    private static readonly DateTime LongAgo = new(2001, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    private readonly ScratchDirectory _scratch = new("modfolder-adapter-");
    private readonly ScratchDirectory _statCache = new("stat-cache-");
    private readonly ModFolderRepository _repository = new(new FakeTimeProvider(TimeProvider.System.GetUtcNow().AddDays(1)));
    private readonly string _root;

    public ModFolderRepositoryTests() => _root = Directory.CreateDirectory(Path.Combine(_scratch, "mod")).FullName;

    public void Dispose()
    {
        _scratch.Dispose();
        _statCache.Dispose();
    }

    [Fact]
    public void Files_ListsEveryFileByForwardSlashPath_HashedAsWabbajackHashes()
    {
        Write("readme.txt", "abc");
        Write(Path.Combine("meshes", "deep", "a.nif"), "hello");

        var files = _repository.Files(_root, new HashSet<string>(), statCache: null).Files.OrderBy(f => f.Path, StringComparer.Ordinal).ToList();

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

        Assert.Equal(["a.txt"], _repository.Files(_root, new HashSet<string>(), statCache: null).Files.Select(f => f.Path));
        Assert.Equal(["a.txt"], _repository.FilePaths(_root));
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
        unsettled.KeepInStatCache(unsettled.Files(_root, new HashSet<string>(), _statCache), NoLines, NoHashes);
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
        _repository.KeepInStatCache(_repository.Files(_root, new HashSet<string>(), _statCache), NoLines, NoHashes);
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

        var read = _repository.Files(_root, new HashSet<string>(), taken);

        Assert.Equal(HashOfHello, Assert.Single(read.Files).Hash);
        Assert.Contains(taken, _repository.KeepInStatCache(read, NoLines, NoHashes), StringComparison.Ordinal);
    }

    [Fact]
    public void TwoFoldersOfOneName_KeepTheirStatCachesApart()
    {
        Write("a.txt", "hello");
        var other = Directory.CreateDirectory(Path.Combine(_scratch, "plugins", "mod")).FullName;
        File.WriteAllText(Path.Combine(other, "a.txt"), "other bytes");
        _repository.KeepInStatCache(_repository.Files(_root, new HashSet<string>(), _statCache), NoLines, NoHashes);
        _repository.KeepInStatCache(_repository.Files(other, new HashSet<string>(), _statCache), NoLines, NoHashes);
        using var held = HeldOpen("a.txt");

        Assert.Equal(HashOfHello, Assert.Single(_repository.Files(_root, new HashSet<string>(), _statCache).Files).Hash);
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

    [PosixFact]
    public void OnAFileSystemThatTellsCaseApart_TwoManifestsWhoseNamesDifferInCaseAlone_AreRefusedNamingBoth()
    {
        Write("mod.manifest.json", "{\n\"files\": []\n}\n");
        Write("MOD.manifest.json", "{\n\"files\": []\n}\n");

        var refused = Assert.Throws<InvalidDataException>(() => _repository.ReadManifest(_root));

        Assert.Equal("its folder holds two manifests, 'MOD.manifest.json' and 'mod.manifest.json'", refused.Message);
    }

    [Fact]
    public void AManifestThatNamesNothing_IsReadBack_AndAgreesWithAFolderOfItsMetadataAlone()
    {
        Write("meta.ini", "[General]");
        var nothing = new Manifest([], []);

        ManifestOnDisk.Write(_repository, _root, nothing);

        var read = Assert.IsType<Manifest>(_repository.ReadManifest(_root));
        Assert.Empty(read.Files);
        Assert.Empty(read.Packages);
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

        Assert.Equal(["a.txt"], _repository.Files(_root, new HashSet<string> { "meta.ini" }, statCache: null).Files.Select(f => f.Path));
    }

    private static readonly ManifestPackage.InstallationFile Package = new("Mod.7z", 100, "AAAA", "https://www.nexusmods.com/fallout4/mods/1");

    [Fact]
    public void ASourceManifest_NamesEachPackageOnce_AndAFileNamesItsPackageOnlyWhenItIsNotTheFirst_AndReadsThemBack()
    {
        var manifest = new Manifest(
            [new ManifestPackage.SourceRepository("Mod", IsSubmodule: true), new ManifestPackage.InstallationFile("Zed.7z", 7, "ZZZZ"),
                new ManifestPackage.InstallationFile("Alpha.zip", 5, "AAAA", "https://www.nexusmods.com/fallout4/mods/1")],
            [new ManifestFile("a.nif", new PackageEntry.Held()), new ManifestFile("b.nif", new PackageEntry.Held(), "Zed.7z"),
                new ManifestFile("c.nif", new PackageEntry.NotHeld(), "Alpha.zip"), new ManifestFile("d.nif", new PackageEntry.OtherBytes(), "Alpha.zip"),
                new ManifestFile("e.nif", ManifestFile.At("e.nif", new FileBytes.InInstallationFile("Alpha.zip", "meshes/e.nif")).Entry, "Alpha.zip"),
                new ManifestFile("f.nif", new PackageEntry.Held(), "Mod")])
        {
            Output = "mod",
        };

        _repository.WriteSourceManifest(_root, manifest);

        Assert.Equal(
            "{\n\"output\": \"mod\",\n\"packages\": [\n"
            + "{\"submodule\":\"Mod\"},\n"
            + "{\"installationFile\":\"Zed.7z\",\"size\":7,\"hash\":\"ZZZZ\"},\n"
            + "{\"installationFile\":\"Alpha.zip\",\"size\":5,\"hash\":\"AAAA\",\"page\":\"https://www.nexusmods.com/fallout4/mods/1\"}\n"
            + "],\n"
            + "\"files\": [\n"
            + "{\"path\":\"a.nif\"},\n"
            + "{\"path\":\"b.nif\",\"package\":\"Zed.7z\"},\n"
            + "{\"path\":\"c.nif\",\"package\":\"Alpha.zip\",\"inPackage\":false},\n"
            + "{\"path\":\"d.nif\",\"package\":\"Alpha.zip\",\"otherBytes\":true},\n"
            + "{\"path\":\"e.nif\",\"package\":\"Alpha.zip\",\"packagePath\":\"meshes/e.nif\"},\n"
            + "{\"path\":\"f.nif\"}\n"
            + "]\n"
            + "}\n",
            File.ReadAllText(Path.Combine(_root, "mod.manifest.json")));
        Assert.True(_repository.ReadSourceManifest(_root).Holds(out var held, out _));
        var read = held.Require();
        Assert.Equal(manifest.Packages, read.Packages);
        Assert.Equal(
            [manifest.Files[0], manifest.Files[1], manifest.Files[2], manifest.Files[3], manifest.Files[4], manifest.Files[5] with { Package = null }],
            read.Files);
    }

    public static TheoryData<Manifest> Manifests => new()
    {
        new Manifest(
            [Package],
            [
                new ManifestFile("a.nif", new PackageEntry.Held()),
                ManifestFile.At("b.nif", new FileBytes.InInstallationFile("Mod.7z", "Data/b.nif")),
                new ManifestFile("z.txt", new PackageEntry.NotHeld()),
            ],
            "1.2.3"),
        new Manifest([new ManifestPackage.InstallationFile("Mod.7z", 100, "AAAA")], [new ManifestFile("a.nif", new PackageEntry.Held())]),
        new Manifest([new ManifestPackage.SourceRepository("Mod", IsSubmodule: true)], [new ManifestFile("d.esp", new PackageEntry.Held())], "2"),
        new Manifest([new ManifestPackage.SourceRepository("Mod", IsSubmodule: false)], [new ManifestFile("d.esp", new PackageEntry.Held())]),
        new Manifest([new ManifestPackage.GameFolder("Fallout 4", "AAAA")], [new ManifestFile("d.esp", new PackageEntry.Held())], "2"),
        new Manifest([new ManifestPackage.GameFolder("Fallout 4", "AAAA", [new GameDepot("377161", "11")])], [new ManifestFile("d.esp", new PackageEntry.Held())]),
        new Manifest([], []),
        new Manifest([new ManifestPackage.InstallationFile("Mod.7z", 100, "AAAA")], [new ManifestFile("a.esp", new PackageEntry.OtherBytes())]),
    };

    [Theory]
    [MemberData(nameof(Manifests))]
    public void ReadManifest_ReadsWhatTheRepositorySpells(Manifest manifest)
    {
        ManifestOnDisk.Write(_repository, _root, manifest);

        var read = _repository.ReadManifest(_root);

        Assert.NotNull(read);
        Assert.Equal(manifest.Packages, read.Packages);
        Assert.Equal(manifest.Version, read.Version);
        Assert.Equal(manifest.Files, read.Files);
    }

    [Fact]
    public void AManifestsSteps_ReadBackInTheirOrder_WithTheToolsAndTheFilesTheyMake()
    {
        ManifestOnDisk.Write(_repository, _root, new Manifest([], [new ManifestFile("b.dds", new PackageEntry.MadeByStep())])
        {
            Steps = [new ManifestStep("Zip", ["a", "b"]), new ManifestStep("Archive", [])],
            Tools = [new ManifestTool("Zip", "https://example.com/zip")],
        });

        var read = _repository.ReadManifest(_root);

        Assert.NotNull(read);
        Assert.Equal([("Zip", "a|b"), ("Archive", "")], read.Steps.Select(step => (step.Task, string.Join('|', step.Args))));
        Assert.Equal([new ManifestTool("Zip", "https://example.com/zip")], read.Tools);
        Assert.Equal([new ManifestFile("b.dds", new PackageEntry.MadeByStep())], read.Files);
    }

    [Fact]
    public void ReadManifest_OfAModWithNone_IsNull()
    {
        Write("a.txt", "abc");

        Assert.Null(_repository.ReadManifest(_root));
        Assert.Null(_repository.ReadManifest(Path.Combine(_root, "absent")));
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
    [InlineData("{\"files\": [{\"path\":\"a.txt\",\"package\":\"A.zip\"}]}", "its file 1: it names a package the manifest does not name")]
    [InlineData("{\"packages\": [{\"installationFile\":\"A.zip\",\"size\":1,\"hash\":\"H\"}], \"steps\": [{\"task\":\"Zip\"}], \"files\": [{\"path\":\"a.txt\",\"package\":\"A.zip\",\"madeByStep\":true}]}", "its file 1: it names a package for a file a step makes")]
    [InlineData("{\"packages\": [{\"installationFile\":\"A.zip\",\"size\":1,\"hash\":\"H\"}, {\"installationFile\":\"A.zip\",\"size\":2,\"hash\":\"G\"}], \"files\": []}", "names the package 'A.zip' twice")]
    [InlineData("{\"packages\": [{\"submodule\":\"Mod\"}, {\"installationFile\":\"A.zip\",\"size\":1,\"hash\":\"H\",\"version\":\"2\"}], \"files\": []}", "its manifest's package 2 holds a version")]
    [InlineData("{\"packages\": [{\"installationFile\":\"A.zip\"}], \"files\": []}", "its manifest cannot be read at its package 1")]
    [InlineData("{\"packages\": [{\"installationFile\":\"A.zip\",\"size\":1,\"hash\":\"H\",\"path\":\"C:/A.zip\"}], \"files\": []}", "its manifest's package 1 holds 'path'")]
    [InlineData("{\"files\": []", "line")]
    [InlineData("{\"packages\": [{\"remote\":\"https://example.com/mod.git\"}], \"files\": []}", "holds 'remote'")]
    [InlineData("{\"packages\": [{\"version\": 7}], \"files\": []}", "cannot be read")]
    [InlineData("{}", "cannot be read")]
    [InlineData("{\"steps\": [{\"task\":\"Zip\"}], \"files\": [{\"path\":\"a.txt\",\"madeByStep\":false}]}", "its file 1: its madeByStep is false")]
    [InlineData("{\"steps\": [{\"task\":\"Zip\"}], \"files\": [{\"path\":\"a.txt\",\"madeByStep\":true,\"otherBytes\":true}]}", "its file 1: it says both")]
    [InlineData("{\"steps\": [{\"task\":\"Zip\"}], \"files\": [{\"path\":\"a.txt\",\"madeByStep\":true,\"inPackage\":false}]}", "its file 1: it says both")]
    [InlineData("{\"steps\": [{\"task\":\"Zip\"}], \"files\": [{\"path\":\"a.txt\",\"madeByStep\":true,\"packagePath\":\"b.txt\"}]}", "its file 1: it names a path")]
    [InlineData("{\"files\": [{\"path\":\"a.txt\",\"madeByStep\":true}]}", "its file 1: it says a step makes the file, and the manifest holds no step")]
    [InlineData("{\"steps\": [{\"task\":\"\"}], \"files\": []}", "its manifest cannot be read at its step 1: it names no task")]
    [InlineData("{\"steps\": [{\"args\":[\"a\"]}], \"files\": []}", "its manifest cannot be read at its step 1")]
    [InlineData("{\"steps\": [{\"task\":\"Zip\",\"args\":[1]}], \"files\": []}", "its manifest cannot be read at its step 1")]
    [InlineData("{\"tools\": [{\"page\":\"https://example.com\"}], \"files\": []}", "its manifest cannot be read at its tool 1")]
    [InlineData("{\"tools\": [{\"task\":\"Zip\"}], \"files\": []}", "its manifest cannot be read at its tool 1")]
    [InlineData("{\"tools\": [{\"task\":\"Zip\",\"page\":\" \"}], \"files\": []}", "its manifest cannot be read at its tool 1: it names no page")]
    [InlineData("{\"tools\": [{\"task\":\"\",\"page\":\"https://example.com\"}], \"files\": []}", "its manifest cannot be read at its tool 1: it names no task")]
    [InlineData("{\"tools\": [{\"task\":\"Zip\",\"page\":\"https://example.com\",\"path\":\"C:/zip.exe\"}], \"files\": []}", "its manifest's tool 1 holds 'path', which Modbench does not read")]
    public void ReadManifest_WithTextItCannotRead_RefusesNamingWhere(string text, string where)
    {
        Write("mod.manifest.json", text);

        var refused = Assert.Throws<InvalidDataException>(() => _repository.ReadManifest(_root));

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

    private static readonly Manifest NoLines = new([], []);

    private static readonly Dictionary<string, string> NoHashes = [];

    private IReadOnlyList<HashedFile> Files()
    {
        var read = _repository.Files(_root, new HashSet<string>(), _statCache);
        _repository.KeepInStatCache(read, NoLines, NoHashes);
        return read.Files;
    }

    private FileStream HeldOpen(string relative) =>
        new(Path.Combine(_root, relative), FileMode.Open, FileAccess.Read, FileShare.None);

    private sealed record CachedEntry(long Size, long Modified, long Changed, string Hash);

    private string StatCacheFile => Assert.Single(Directory.GetFiles(_statCache));

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
