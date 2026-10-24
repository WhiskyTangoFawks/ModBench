using System.IO.Compression;
using System.Text;
using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.Ports;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Build;

public sealed class RestoreFromManifestHandlerTests
{
    private const string Mod = "mods/Mod";
    private const string Other = "mods/Other";

    private const string SolidSevenZipOfReadmeAndMeshes =
        "N3q8ryccAATuUVnEpgAAAAAAAAAhAAAAAAAAAC+dzs3gIAIAKV0AMO/7v/6jsV7l+D+yqiZV+GhwQXAVD439HkwbikK3GfRpGHAufifG/wAAAACBMweuD9EP9rigkKB3XrpXH+ax2dPvt7i58wldO1uKWgKup3uXhzzBgYN/yWVyKGG6hrzHb+8AS3A4eb6xWIpNOTGqvAgOWKrbXPL2/IPdDY8hq8YbGjaD7xEjTC7CbMP6A0APd4UmYIrlYd9r+G9HAAAAFwYxAQl1AAcLAQABIwMBAQVdABAAAAyAhgoBy3m54QAA";

    private readonly FakeModFolders _folders = new();
    private readonly InMemoryNotificationPublisher _notifications = new();

    private RestoreFromManifestHandler Handler => TestEditService.RestoreHandler(new LoadOrderHolder(), _notifications, new FakeSourceAdapter(), _folders);

    private static InstanceToRestore Instance() => new("stat-cache", ".mohidden", Archives: null);

    private static ModToRestore ModFrom(string folder, InstallationFile? installationFile = null) =>
        new(folder[(folder.LastIndexOf('/') + 1)..], folder, installationFile, ["meta.ini"]);

    private InstallationFile DownloadedFile(string path, params (string Path, string Text)[] entries) =>
        DownloadedFileOfBytes(path, [.. entries.Select(e => (e.Path, Encoding.ASCII.GetBytes(e.Text)))]);

    private InstallationFile DownloadedFileOfBytes(string path, params (string Path, byte[] Bytes)[] entries)
    {
        _folders.WithBytes(string.Empty, path, Zip(entries));
        return new InstallationFile(path, Page: null, Size: 7, Hash: $"#{path}", [.. entries.Select(e => new HashedEntry(e.Path, Encoding.ASCII.GetString(e.Bytes)))]);
    }

    private static ManifestPackage.InstallationFile PackageOf(InstallationFile file) =>
        new(file.Path[(file.Path.LastIndexOf('/') + 1)..], file.Size, file.Hash);

    private static ManifestFile Line(string path, PackageEntry entry) => new(path, entry);

    private void Manifested(string folder, InstallationFile installationFile, params ManifestFile[] files) =>
        _folders.Manifests[folder] = new Manifest(PackageOf(installationFile), files);

    private string? WrittenText(string folder, string path) =>
        _folders.Written.TryGetValue((folder, path), out var bytes) ? Encoding.ASCII.GetString(bytes) : null;

    private IEnumerable<(string Folder, string Path)> WrittenIn(string folder) => _folders.Written.Keys.Where(key => key.Folder == folder);

    private IEnumerable<ModlistProgress> Progress =>
        _notifications.Notifications.OfType<RestoreFromManifestProgressNotification>().Select(n => n.Progress);

    private static byte[] Zip(params (string Path, byte[] Bytes)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (path, bytes) in entries)
            {
                using var entry = archive.CreateEntry(path).Open();
                entry.Write(bytes);
            }
        }
        return buffer.ToArray();
    }

    private ModToRestore AnotherModThatLands()
    {
        var downloadedFile = DownloadedFile("dl/Other.zip", ("o.txt", "o"));
        _folders.WithFile(Other, "o.txt", "changed");
        Manifested(Other, downloadedFile, Line("o.txt", new PackageEntry.Held()));
        return ModFrom(Other, downloadedFile);
    }

    [Fact]
    public async Task AFileWhoseBytesDiffer_ComesBackFromItsInstallationFile_EachFileNoLineNamesIsNamed_AndEveryOtherFileIsLeftAlone()
    {
        var downloadedFile = DownloadedFile("dl/Mod.zip", ("a.nif", "a"), ("b.nif", "b"));
        _folders.WithFile(Mod, "a.nif", "edited").WithFile(Mod, "b.nif", "b").WithFile(Mod, "nonCompiledPlugin.txt", "mine").WithFile(Mod, "meta.ini", "[General]");
        Manifested(Mod, downloadedFile, Line("a.nif", new PackageEntry.Held()), Line("b.nif", new PackageEntry.Held()));

        var restored = Assert.Single((await Handler.RestoreAsync([ModFrom(Mod, downloadedFile)], Instance())).Applied);

        Assert.Equal(["a.nif"], restored.Written);
        Assert.Equal(["nonCompiledPlugin.txt"], restored.NamedByNoLine);
        Assert.Equal([(Mod, "a.nif")], WrittenIn(Mod));
        Assert.Equal("a", WrittenText(Mod, "a.nif"));
    }

    [Fact]
    public async Task AManifestThatNamesNothing_LandsWritingNothing_AndNamingItsMetadataNowhere()
    {
        _folders.WithFile(Mod, "meta.ini", "[General]");
        _folders.Manifests[Mod] = new Manifest(null, []);

        var restored = Assert.Single((await Handler.RestoreAsync([ModFrom(Mod)], Instance())).Applied);

        Assert.Empty(restored.Written.Concat(restored.NamedByNoLine));
        Assert.Empty(_folders.Written);
    }

    [Fact]
    public async Task ARestoredMod_KeepsInItsStatCache_TheHashItsPackageFixesForEachFile()
    {
        var downloadedFile = DownloadedFile("dl/Mod.zip", ("a.nif", "a"));
        _folders.WithFile(Mod, "a.nif", "edited");
        Manifested(Mod, downloadedFile, Line("a.nif", new PackageEntry.Held()));

        await Handler.RestoreAsync([ModFrom(Mod, downloadedFile)], Instance());

        Assert.Equal(new Dictionary<string, string> { ["a.nif"] = "a" }, _folders.KeptPackageHashes[Mod]);
    }

    [Fact]
    public async Task AModWhoseStatCacheCannotBeWritten_Lands_NamingWhy()
    {
        var downloadedFile = DownloadedFile("dl/Mod.zip", ("a.nif", "a"));
        _folders.WithFile(Mod, "a.nif", "a");
        Manifested(Mod, downloadedFile, Line("a.nif", new PackageEntry.Held()));
        _folders.UnwritableStatCaches.Add(Mod);

        var result = await Handler.RestoreAsync([ModFrom(Mod, downloadedFile)], Instance());

        Assert.Equal("stat-cache is read-only", Assert.Single(result.Applied).StatCacheNotWritten);
    }

    [Fact]
    public async Task ALandedMod_AnswersTheVersionAndPageItsManifestSays_ForTheExtensionToWrite()
    {
        var downloadedFile = DownloadedFile("dl/Mod.zip", ("a.nif", "a"));
        _folders.WithFile(Mod, "a.nif", "a");
        _folders.Manifests[Mod] = new Manifest(PackageOf(downloadedFile) with { Page = "nexus:fallout4:7;7:9" }, [Line("a.nif", new PackageEntry.Held())], "1.2");

        var result = await Handler.RestoreAsync([ModFrom(Mod, downloadedFile)], Instance());

        var metadata = Assert.Single(result.Applied).Metadata;
        Assert.Equal("1.2", metadata.Version);
        Assert.Equal(new MetadataInstallationFile("Mod.zip", "nexus:fallout4:7;7:9"), metadata.InstallationFile);
    }

    [Fact]
    public async Task AModWhoseFilesAllMatch_LandsHavingWrittenNothing_AndOpensNoInstallationFile()
    {
        var downloadedFile = DownloadedFile("dl/Mod.zip", ("a.nif", "a"));
        _folders.WithFile(Mod, "a.nif", "a");
        Manifested(Mod, downloadedFile, Line("a.nif", new PackageEntry.Held()));

        var result = await Handler.RestoreAsync([ModFrom(Mod, downloadedFile)], Instance());

        Assert.Empty(Assert.Single(result.Applied).Written);
        Assert.Equal(0, _folders.Opens);
    }

    [Fact]
    public async Task AFileTheManifestNamesThatIsGone_ComesBackFromTheEntryItNames()
    {
        var downloadedFile = DownloadedFile("dl/Patch.zip", ("Meshes/A.nif", "x"));
        _folders.WithFile(Mod, "meta.ini", "[General]");
        Manifested(Mod, downloadedFile, ManifestFile.At("meshes/a.nif", new FileBytes.InInstallationFile("Patch.zip", "Meshes/A.nif")));

        await Handler.RestoreAsync([ModFrom(Mod, downloadedFile)], Instance());

        Assert.Equal("x", WrittenText(Mod, "meshes/a.nif"));
    }

    [Fact]
    public async Task OneEntryProvidingTwoFiles_WritesBoth()
    {
        var downloadedFile = DownloadedFile("dl/Mod.zip", ("a.nif", "a"));
        _folders.WithFile(Mod, "meta.ini", "[General]");
        Manifested(Mod, downloadedFile, Line("a.nif", new PackageEntry.Held()), ManifestFile.At("copy/x.nif", new FileBytes.InInstallationFile("Mod.zip", "a.nif")));

        await Handler.RestoreAsync([ModFrom(Mod, downloadedFile)], Instance());

        Assert.Equal(("a", "a"), (WrittenText(Mod, "a.nif"), WrittenText(Mod, "copy/x.nif")));
    }

    [Theory]
    [InlineData("installation file not handed", RestoreRefusal.NotFound, "installation file 'Mod.zip' is missing")]
    [InlineData("installation file gone", RestoreRefusal.Lacking, "installation file 'Mod.zip' is not in the downloads folder")]
    [InlineData("installation file changed", RestoreRefusal.Lacking, "installation file 'Mod.zip' has other bytes")]
    [InlineData("not in the package", RestoreRefusal.Lacking, "its package does not hold 'mine.txt'")]
    [InlineData("entry gone", RestoreRefusal.Lacking, "installation file 'Mod.zip' holds no 'gone.nif'")]
    public async Task AModThatLacksItsPackageOrAFileOfIt_IsSkippedNamingIt_WritesNothing_AndTheOthersLand(string cause, RestoreRefusal refusal, string lack)
    {
        var downloadedFile = DownloadedFile("dl/Mod.zip", ("a.nif", "a"));
        _folders.WithFile(Mod, "a.nif", "edited").WithFile(Mod, "mine.txt", "changed");
        ManifestFile[] lines = cause switch
        {
            "not in the package" => [Line("mine.txt", new PackageEntry.NotHeld())],
            "entry gone" => [Line("gone.nif", new PackageEntry.Held())],
            _ => [],
        };
        _folders.Manifests[Mod] = new Manifest(PackageOf(downloadedFile), [Line("a.nif", new PackageEntry.Held()), .. lines]);
        var handed = cause switch
        {
            "installation file not handed" => ModFrom(Mod),
            "installation file gone" => ModFrom(Mod, downloadedFile with { Path = "dl/Gone/Mod.zip" }),
            "installation file changed" => ModFrom(Mod, downloadedFile with { Hash = "#other" }),
            _ => ModFrom(Mod, downloadedFile),
        };

        var result = await Handler.RestoreAsync([handed, AnotherModThatLands()], Instance());

        var skipped = Assert.Single(result.Refused);
        Assert.Equal(("Mod", refusal), (skipped.Item, skipped.Refusal));
        Assert.Equal($"was skipped: {lack}.", skipped.Message);
        Assert.Empty(WrittenIn(Mod));
        Assert.Equal("Other", Assert.Single(result.Applied).Mod);
    }

    [Fact]
    public async Task AManifestWithHeldFilesAndNoPackage_IsSkipped_NamingEachFile()
    {
        _folders.WithFile(Mod, "a.nif", "a");
        _folders.Manifests[Mod] = new Manifest(null, [Line("a.nif", new PackageEntry.Held())]);

        var skipped = Assert.Single((await Handler.RestoreAsync([ModFrom(Mod)], Instance())).Refused);

        Assert.Equal((RestoreRefusal.Lacking, "was skipped: 'a.nif' names no installation file."), (skipped.Refusal, skipped.Message));
    }

    [Fact]
    public async Task AModLackingItsInstallationFile_NamesItAsItsManifestDoes_SoARequestCanFetchAndHandIt()
    {
        _folders.WithFile(Mod, "meta.ini", "[General]");
        var named = new ManifestPackage.InstallationFile("Mod.zip", 7, "#dl/Mod.zip", "https://www.nexusmods.com/fallout4/mods/1?tab=files&file_id=2");
        _folders.Manifests[Mod] = new Manifest(named, []);

        var skipped = Assert.Single((await Handler.RestoreAsync([ModFrom(Mod)], Instance())).Refused);

        Assert.Equal(RestoreRefusal.NotFound, skipped.Refusal);
        Assert.Equal(named, skipped.InstallationFileNotFound);
    }

    [Fact]
    public async Task AModWhoseFilesAllMatch_IsStillSkipped_WhenAnInstallationFileItsManifestNamesIsMissing()
    {
        var downloadedFile = DownloadedFile("dl/Mod.zip", ("a.nif", "a"));
        _folders.WithFile(Mod, "a.nif", "a");
        Manifested(Mod, downloadedFile, Line("a.nif", new PackageEntry.Held()));

        var skipped = Assert.Single((await Handler.RestoreAsync([ModFrom(Mod, downloadedFile with { Path = "dl/Gone/Mod.zip" })], Instance())).Refused);

        Assert.Equal("was skipped: installation file 'Mod.zip' is not in the downloads folder.", skipped.Message);
    }

    [Fact]
    public async Task AFileComesBackFromASolidSevenZipsEntry()
    {
        var copy = new string('a', 8192);
        _folders.WithFile(Mod, "meshes/a.nif", "edited").WithBytes(string.Empty, "dl/Mod.7z", Convert.FromBase64String(SolidSevenZipOfReadmeAndMeshes));
        var downloadedFile = new InstallationFile("dl/Mod.7z", null, 231, "#7z", [new HashedEntry("readme.txt", "abc"), new HashedEntry("meshes/a.nif", copy)]);
        Manifested(Mod, downloadedFile, Line("meshes/a.nif", new PackageEntry.Held()));

        await Handler.RestoreAsync([ModFrom(Mod, downloadedFile)], Instance());

        Assert.Equal(copy, WrittenText(Mod, "meshes/a.nif"));
    }

    [Fact]
    public async Task AFileComesBackFromAnEntryNamedWithBackslashes()
    {
        _folders.WithFile(Mod, "meshes/a.nif", "edited").WithBytes(string.Empty, "dl/Mod.zip", Zip(("meshes\\a.nif", "a"u8.ToArray())));
        var downloadedFile = new InstallationFile("dl/Mod.zip", null, 7, "#zip", [new HashedEntry("meshes/a.nif", "a")]);
        Manifested(Mod, downloadedFile, Line("meshes/a.nif", new PackageEntry.Held()));

        await Handler.RestoreAsync([ModFrom(Mod, downloadedFile)], Instance());

        Assert.Equal("a", WrittenText(Mod, "meshes/a.nif"));
    }

    [Fact]
    public async Task AnInstallationFileThatIsNoArchive_LeavesTheModNotFinished_NamingIt_PromisingNoRetryMends_AndTheOthersLand()
    {
        _folders.WithFile(Mod, "a.nif", "edited").WithFile(string.Empty, "dl/Mod.zip", "not an archive");
        var downloadedFile = new InstallationFile("dl/Mod.zip", null, 14, "#zip", [new HashedEntry("a.nif", "a")]);
        Manifested(Mod, downloadedFile, Line("a.nif", new PackageEntry.Held()));

        var result = await Handler.RestoreAsync([ModFrom(Mod, downloadedFile), AnotherModThatLands()], Instance());

        var unfinished = Assert.Single(result.Refused);
        Assert.Equal(RestoreRefusal.NotFinished, unfinished.Refusal);
        Assert.StartsWith("was not finished: 'Mod.zip' is not an archive restore from manifest can read:", unfinished.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("again", unfinished.Message, StringComparison.Ordinal);
        Assert.Equal("Other", Assert.Single(result.Applied).Mod);
    }

    [Fact]
    public async Task AModLackingItsInstallationFileAndHoldingNoFileOfIt_NamesBoth()
    {
        _folders.WithFile(Mod, "a.nif", "edited");
        _folders.Manifests[Mod] = new Manifest(
            new ManifestPackage.InstallationFile("Mod.zip", 7, "#dl/Mod.zip"),
            [Line("a.nif", new PackageEntry.Held()), Line("c.nif", new PackageEntry.NotHeld())]);

        var skipped = Assert.Single((await Handler.RestoreAsync([ModFrom(Mod)], Instance())).Refused);

        Assert.Equal("was skipped: installation file 'Mod.zip' is missing; its package does not hold 'c.nif'.", skipped.Message);
    }

    [Fact]
    public async Task AModWithNoManifest_IsSkippedSayingSo()
    {
        _folders.WithFile(Mod, "a.nif", "a");

        var skipped = Assert.Single((await Handler.RestoreAsync([ModFrom(Mod)], Instance())).Refused);

        Assert.Equal((RestoreRefusal.NoManifest, "was skipped: it has no manifest."), (skipped.Refusal, skipped.Message));
    }

    [Fact]
    public async Task AModWhoseManifestCannotBeRead_IsSkippedNamingTheLine()
    {
        _folders.WithFile(Mod, "a.nif", "a");
        _folders.UnreadableManifests.Add(Mod);

        var skipped = Assert.Single((await Handler.RestoreAsync([ModFrom(Mod)], Instance())).Refused);

        Assert.Equal((RestoreRefusal.ManifestUnreadable, "was skipped: its manifest cannot be read at line 1."), (skipped.Refusal, skipped.Message));
    }

    [Fact]
    public async Task AWriteThatFailsPartWay_SaysTheModWasNotFinished_AndTheOthersLand()
    {
        var downloadedFile = DownloadedFile("dl/Mod.zip", ("a.nif", "a"), ("b.nif", "b"));
        _folders.WithFile(Mod, "a.nif", "edited").WithFile(Mod, "b.nif", "edited");
        Manifested(Mod, downloadedFile, Line("a.nif", new PackageEntry.Held()), Line("b.nif", new PackageEntry.Held()));
        _folders.UnwritableFiles.Add((Mod, "b.nif"));

        var result = await Handler.RestoreAsync([ModFrom(Mod, downloadedFile), AnotherModThatLands()], Instance());

        var unfinished = Assert.Single(result.Refused);
        Assert.Equal(
            (RestoreRefusal.NotFinished, "was not finished: b.nif is held by another process. Restoring it again finishes it."),
            (unfinished.Refusal, unfinished.Message));
        Assert.Equal("a", WrittenText(Mod, "a.nif"));
        Assert.Equal("Other", Assert.Single(result.Applied).Mod);
    }

    [Fact]
    public async Task ProgressNamesItsGestureAndEachModInFlight_ThenGoesIdle()
    {
        _folders.WithFile("mods/A", "a.txt", "hello").WithFile("mods/B", "a.txt", "hello");

        await Handler.RestoreAsync([ModFrom("mods/A"), ModFrom("mods/B")], Instance(), "g");

        Assert.Equal(
            [new ModlistProgress("g", "A", 0, 2), new ModlistProgress("g", "B", 1, 2), new ModlistProgress("g", null, 0, 0)], Progress);
    }

    private void GameFolderModManifested(params (string Path, string Text)[] taken) =>
        _folders.Manifests[Mod] = new Manifest(
            new ManifestPackage.GameFolder("Fallout 4", FileHash.OfFilesTaken([.. taken.Select(file => new HashedFile(file.Path, file.Text))])),
            [.. taken.Select(file => Line(file.Path, new PackageEntry.Held()))]);

    private static InstanceToRestore InstanceWithGameFiles(params (string Path, string Text)[] files) =>
        Instance() with { GameFolder = new GameFolder("Fallout 4", "data", [.. files.Select(file => new GameFile(file.Path, file.Text))]) };

    [Fact]
    public async Task AGameFolderModsFileWhoseBytesDiffer_ComesBackFromTheGameFolder_AndAFileWhoseBytesMatchIsLeftAlone()
    {
        _folders.WithFile("data", "Meshes/A.nif", "a").WithFile("data", "b.dds", "b");
        _folders.WithFile(Mod, "meshes/a.nif", "edited").WithFile(Mod, "b.dds", "b");
        GameFolderModManifested(("meshes/a.nif", "a"), ("b.dds", "b"));

        var restored = Assert.Single((await Handler.RestoreAsync([ModFrom(Mod)], InstanceWithGameFiles(("Meshes/A.nif", "a"), ("b.dds", "b")))).Applied);

        Assert.Equal(["meshes/a.nif"], restored.Written);
        Assert.Equal("a", WrittenText(Mod, "meshes/a.nif"));
        Assert.Equal([(Mod, "meshes/a.nif")], WrittenIn(Mod));
    }

    [Fact]
    public async Task AGameFolderMod_WhoseGameFilesTheRequestDidNotHand_IsNotFound_NamingEach()
    {
        _folders.WithFile(Mod, "a.nif", "a").WithFile(Mod, "b.dds", "b");
        GameFolderModManifested(("a.nif", "a"), ("b.dds", "b"));

        var refused = Assert.Single((await Handler.RestoreAsync([ModFrom(Mod)], Instance())).Refused);

        Assert.Equal(RestoreRefusal.NotFound, refused.Refusal);
        Assert.Equal(["a.nif", "b.dds"], refused.GameFilesNotFound);
        Assert.Empty(WrittenIn(Mod));
    }

    [Fact]
    public async Task AGameFolderMod_WhoseGameFilesTheRequestCouldNotRead_IsSkippedNamingEachAsUnreadable_NeverMissing()
    {
        _folders.WithFile(Mod, "a.nif", "a").WithFile(Mod, "b.dds", "b");
        GameFolderModManifested(("a.nif", "a"), ("b.dds", "b"));
        var unread = ModFrom(Mod) with { UnreadableGameFiles = new Dictionary<string, string> { ["a.nif"] = "EACCES", ["b.dds"] = "EACCES" } };

        var refused = Assert.Single((await Handler.RestoreAsync([unread], Instance())).Refused);

        Assert.Equal(RestoreRefusal.Lacking, refused.Refusal);
        Assert.Equal("was skipped: game file 'a.nif' could not be read: EACCES; game file 'b.dds' could not be read: EACCES.", refused.Message);
    }

    [Fact]
    public async Task AModWithGameFilesTheRequestCouldNotRead_AndAnotherLack_NamesBoth()
    {
        _folders.WithFile(Mod, "a.nif", "a");
        _folders.Manifests[Mod] = new Manifest(
            new ManifestPackage.GameFolder("Fallout 4", "#"), [Line("a.nif", new PackageEntry.Held()), Line("mine.txt", new PackageEntry.NotHeld())]);
        var unread = ModFrom(Mod) with { UnreadableGameFiles = new Dictionary<string, string> { ["a.nif"] = "EACCES" } };

        var refused = Assert.Single((await Handler.RestoreAsync([unread], Instance())).Refused);

        Assert.Equal("was skipped: game file 'a.nif' could not be read: EACCES; its package does not hold 'mine.txt'.", refused.Message);
    }

    [Fact]
    public async Task AModWhoseInstallationFileTheRequestCouldNotRead_IsSkippedNamingItUnreadable_NeverMissing()
    {
        var downloadedFile = DownloadedFile("dl/Mod.zip", ("a.nif", "a"));
        _folders.WithFile(Mod, "a.nif", "a");
        Manifested(Mod, downloadedFile, Line("a.nif", new PackageEntry.Held()));
        var unread = ModFrom(Mod) with { UnreadableInstallationFile = "EACCES" };

        var refused = Assert.Single((await Handler.RestoreAsync([unread], Instance())).Refused);

        Assert.Equal((RestoreRefusal.Lacking, "was skipped: installation file 'Mod.zip' could not be read: EACCES."), (refused.Refusal, refused.Message));
    }

    [Fact]
    public async Task AGameFolderMod_WhoseGameFilesHaveOtherBytes_IsSkippedWritingNothing()
    {
        _folders.WithFile("data", "a.nif", "newer").WithFile(Mod, "a.nif", "edited");
        GameFolderModManifested(("a.nif", "a"));

        var refused = Assert.Single((await Handler.RestoreAsync([ModFrom(Mod)], InstanceWithGameFiles(("a.nif", "newer")))).Refused);

        Assert.Equal(RestoreRefusal.Lacking, refused.Refusal);
        Assert.Contains("'Fallout 4'", refused.Message);
        Assert.Contains("other bytes", refused.Message);
        Assert.Empty(WrittenIn(Mod));
    }
}
