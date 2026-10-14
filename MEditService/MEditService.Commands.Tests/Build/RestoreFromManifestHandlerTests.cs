using System.IO.Compression;
using System.Text;
using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.ModFolderAdapter;
using MEditService.Ports;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Build;

public sealed class RestoreFromManifestHandlerTests
{
    private const string Mod = "mods/Mod";
    private const string Other = "mods/Other";
    private const string DataFolder = "game/Data";

    private const string SolidSevenZipOfReadmeAndMeshes =
        "N3q8ryccAATuUVnEpgAAAAAAAAAhAAAAAAAAAC+dzs3gIAIAKV0AMO/7v/6jsV7l+D+yqiZV+GhwQXAVD439HkwbikK3GfRpGHAufifG/wAAAACBMweuD9EP9rigkKB3XrpXH+ax2dPvt7i58wldO1uKWgKup3uXhzzBgYN/yWVyKGG6hrzHb+8AS3A4eb6xWIpNOTGqvAgOWKrbXPL2/IPdDY8hq8YbGjaD7xEjTC7CbMP6A0APd4UmYIrlYd9r+G9HAAAAFwYxAQl1AAcLAQABIwMBAQVdABAAAAyAhgoBy3m54QAA";

    private readonly FakeModFolders _folders = new();
    private readonly InMemoryNotificationPublisher _notifications = new();

    private RestoreFromManifestHandler Handler => new(_folders, _notifications);

    private static InstanceToRestore Instance(params OverriddenGameFile[] gameFiles) => new(gameFiles, DataFolder, "stat-cache");

    private static ModToRestore ModFrom(string folder, params InstallationFile[] installationFiles) =>
        new(folder[(folder.LastIndexOf('/') + 1)..], folder, installationFiles, ["meta.ini"]);

    private InstallationFile Downloaded(string path, params (string Path, string Text)[] entries) =>
        DownloadedBytes(path, [.. entries.Select(e => (e.Path, Encoding.ASCII.GetBytes(e.Text)))]);

    private InstallationFile DownloadedBytes(string path, params (string Path, byte[] Bytes)[] entries)
    {
        _folders.WithBytes(string.Empty, path, Zip(entries));
        return new InstallationFile(path, Source: null, Size: 7, Hash: $"#{path}", [.. entries.Select(e => new HashedEntry(e.Path, Encoding.ASCII.GetString(e.Bytes)))]);
    }

    private static ManifestSource SourceOf(InstallationFile file) => new(file.Path[(file.Path.LastIndexOf('/') + 1)..], file.Size, file.Hash);

    private static ManifestFile Line(string path, FileProvider provider) => new(path, provider);

    private void Manifested(string folder, IReadOnlyList<InstallationFile> installationFiles, params ManifestFile[] files) =>
        _folders.Manifests[folder] = new Manifest([.. installationFiles.Select(SourceOf)], [], files);

    private void ManifestedWithGameFile(string folder, OverriddenGameFile gameFile, params ManifestFile[] files) =>
        _folders.Manifests[folder] = new Manifest([], [new ManifestSource(gameFile.Path, gameFile.Size, gameFile.Hash)], files);

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
        var download = Downloaded("dl/Other.zip", ("o.txt", "o"));
        _folders.WithFile(Other, "o.txt", "changed");
        Manifested(Other, [download], Line("o.txt", new FileProvider.FirstInstallationFile()));
        return ModFrom(Other, download);
    }

    [Fact]
    public void AFileWhoseBytesDiffer_ComesBackFromItsInstallationFile_EachFileNoLineNamesIsNamed_AndEveryOtherFileIsLeftAlone()
    {
        var download = Downloaded("dl/Mod.zip", ("a.nif", "a"), ("b.nif", "b"));
        _folders.WithFile(Mod, "a.nif", "edited").WithFile(Mod, "b.nif", "b").WithFile(Mod, "untracked.txt", "mine").WithFile(Mod, "meta.ini", "[General]");
        Manifested(Mod, [download], Line("a.nif", new FileProvider.FirstInstallationFile()), Line("b.nif", new FileProvider.FirstInstallationFile()));

        var restored = Assert.Single(Handler.Restore([ModFrom(Mod, download)], Instance()).Landed).Outcome;

        Assert.Equal(["a.nif"], restored.Written);
        Assert.Equal(["untracked.txt"], restored.NamedByNoLine);
        Assert.Equal([(Mod, "a.nif")], WrittenIn(Mod));
        Assert.Equal("a", WrittenText(Mod, "a.nif"));
    }

    [Fact]
    public void ARestoredMod_KeepsInItsStatCache_TheHashEachLinesProviderFixes()
    {
        var download = Downloaded("dl/Mod.zip", ("a.nif", "a"));
        var game = new OverriddenGameFile("Game.esm", 7, "vanilla");
        _folders.WithFile(DataFolder, "Game.esm", "vanilla").WithFile(Mod, "a.nif", "edited");
        _folders.Manifests[Mod] = new Manifest(
            [SourceOf(download)], [new ManifestSource("Game.esm", 7, "vanilla")],
            [Line("a.nif", new FileProvider.FirstInstallationFile()), Line("game.esm", new FileProvider.GameFile("Game.esm"))]);

        Handler.Restore([ModFrom(Mod, download)], Instance(game));

        Assert.Equal(new Dictionary<string, string> { ["a.nif"] = "a", ["game.esm"] = "vanilla" }, _folders.KeptProviderHashes[Mod]);
    }

    [Fact]
    public void AModWhoseStatCacheCannotBeWritten_Lands_NamingWhy()
    {
        var download = Downloaded("dl/Mod.zip", ("a.nif", "a"));
        _folders.WithFile(Mod, "a.nif", "a");
        Manifested(Mod, [download], Line("a.nif", new FileProvider.FirstInstallationFile()));
        _folders.UnwritableStatCaches.Add(Mod);

        var result = Handler.Restore([ModFrom(Mod, download)], Instance());

        Assert.Equal("stat-cache is read-only", Assert.Single(result.Landed).Outcome.StatCacheNotWritten);
    }

    [Fact]
    public void AModWhoseFilesAllMatch_LandsHavingWrittenNothing_AndOpensNoInstallationFile()
    {
        var download = Downloaded("dl/Mod.zip", ("a.nif", "a"));
        _folders.WithFile(Mod, "a.nif", "a");
        Manifested(Mod, [download], Line("a.nif", new FileProvider.FirstInstallationFile()));

        var result = Handler.Restore([ModFrom(Mod, download)], Instance());

        Assert.Empty(Assert.Single(result.Landed).Outcome.Written);
        Assert.Equal(0, _folders.Opens);
    }

    [Fact]
    public void AFileTheManifestNamesThatIsGone_ComesBackFromTheEntryItNames()
    {
        var first = Downloaded("dl/Base.zip", ("readme.txt", "r"));
        var patch = Downloaded("dl/Patch.zip", ("Meshes/A.nif", "x"));
        _folders.WithFile(Mod, "meta.ini", "[General]");
        Manifested(Mod, [first, patch], Line("meshes/a.nif", new FileProvider.InstallationFileEntry("Patch.zip", "Meshes/A.nif")));

        Handler.Restore([ModFrom(Mod, first, patch)], Instance());

        Assert.Equal("x", WrittenText(Mod, "meshes/a.nif"));
    }

    [Fact]
    public void OneEntryProvidingTwoFiles_WritesBoth()
    {
        var download = Downloaded("dl/Mod.zip", ("a.nif", "a"));
        _folders.WithFile(Mod, "meta.ini", "[General]");
        Manifested(Mod, [download],
            Line("a.nif", new FileProvider.FirstInstallationFile()), Line("copy/a.nif", new FileProvider.InstallationFileEntry("Mod.zip", "a.nif")));

        Handler.Restore([ModFrom(Mod, download)], Instance());

        Assert.Equal(("a", "a"), (WrittenText(Mod, "a.nif"), WrittenText(Mod, "copy/a.nif")));
    }

    [Fact]
    public void AFileAGameFileProvides_ComesBackFromTheGameFolder()
    {
        var game = new OverriddenGameFile("Game.esm", 7, "vanilla");
        _folders.WithFile(DataFolder, "Game.esm", "vanilla").WithFile(Mod, "game.esm", "dirty");
        ManifestedWithGameFile(Mod, game, Line("game.esm", new FileProvider.GameFile("Game.esm")));

        Handler.Restore([ModFrom(Mod)], Instance(game));

        Assert.Equal("vanilla", WrittenText(Mod, "game.esm"));
    }

    [Theory]
    [InlineData("installation file not handed", RestoreRefusal.Lacking, "the mod manager records no installation file 'Mod.zip' for it")]
    [InlineData("installation file gone", RestoreRefusal.Lacking, "installation file 'Mod.zip' is not in the downloads folder")]
    [InlineData("installation file changed", RestoreRefusal.Lacking, "installation file 'Mod.zip' has other bytes")]
    [InlineData("game file not found", RestoreRefusal.NotFound, "game file 'Game.esm' is missing")]
    [InlineData("game file changed", RestoreRefusal.Lacking, "game file 'Game.esm' has other bytes")]
    [InlineData("no provider", RestoreRefusal.Lacking, "'mine.txt' has no provider")]
    [InlineData("entry gone", RestoreRefusal.Lacking, "installation file 'Mod.zip' holds no 'gone.nif'")]
    public void AModThatLacksASource_IsSkippedNamingIt_WritesNothing_AndTheOthersLand(string cause, RestoreRefusal refusal, string lack)
    {
        var download = Downloaded("dl/Mod.zip", ("a.nif", "a"));
        var game = new OverriddenGameFile("Game.esm", 7, "vanilla");
        _folders.WithFile(DataFolder, "Game.esm", "vanilla");
        _folders.WithFile(Mod, "a.nif", "edited").WithFile(Mod, "game.esm", "dirty").WithFile(Mod, "mine.txt", "changed");
        ManifestFile[] lines = cause switch
        {
            "no provider" => [Line("mine.txt", new FileProvider.NoProvider())],
            "entry gone" => [Line("gone.nif", new FileProvider.InstallationFileEntry("Mod.zip", "gone.nif"))],
            "game file not found" or "game file changed" => [Line("game.esm", new FileProvider.GameFile("Game.esm"))],
            _ => [],
        };
        _folders.Manifests[Mod] = new Manifest(
            [SourceOf(download)], [new ManifestSource("Game.esm", 7, "vanilla")],
            [Line("a.nif", new FileProvider.FirstInstallationFile()), .. lines]);
        var handed = cause switch
        {
            "installation file not handed" => ModFrom(Mod),
            "installation file gone" => ModFrom(Mod, download with { Path = "dl/Gone/Mod.zip" }),
            "installation file changed" => ModFrom(Mod, download with { Hash = "#other" }),
            _ => ModFrom(Mod, download),
        };
        OverriddenGameFile[] gameFiles = cause switch
        {
            "game file not found" => [],
            "game file changed" => [game with { Hash = "patched" }],
            _ => [game],
        };

        var result = Handler.Restore([handed, AnotherModThatLands()], Instance(gameFiles));

        var skipped = Assert.Single(result.Refused);
        Assert.Equal(("Mod", refusal), (skipped.Item, skipped.Refusal.Kind));
        Assert.Equal($"'Mod' was skipped: {lack}.", skipped.Message);
        Assert.Empty(WrittenIn(Mod));
        Assert.Equal("Other", Assert.Single(result.Landed).Item);
    }

    [Fact]
    public void AModLackingOnlyGameFilesNotHanded_NamesEach_SoARequestNamingThemBringsItBack()
    {
        _folders.WithFile(Mod, "meta.ini", "[General]");
        _folders.Manifests[Mod] = new Manifest(
            [], [new ManifestSource("Game.esm", 7, "vanilla"), new ManifestSource("Other.esm", 5, "other")],
            [Line("Game.esm", new FileProvider.GameFile("Game.esm")), Line("Other.esm", new FileProvider.GameFile("Other.esm"))]);

        var skipped = Assert.Single(Handler.Restore([ModFrom(Mod)], Instance()).Refused);

        Assert.Equal(RestoreRefusal.NotFound, skipped.Refusal.Kind);
        Assert.Equal(["Game.esm", "Other.esm"], skipped.Refusal.GameFilesNotFound);
    }

    [Fact]
    public void AModWhoseFilesAllMatch_IsStillSkipped_WhenAnInstallationFileItsManifestNamesIsMissing()
    {
        var download = Downloaded("dl/Mod.zip", ("a.nif", "a"));
        _folders.WithFile(Mod, "a.nif", "a");
        Manifested(Mod, [download], Line("a.nif", new FileProvider.FirstInstallationFile()));

        var skipped = Assert.Single(Handler.Restore([ModFrom(Mod, download with { Path = "dl/Gone/Mod.zip" })], Instance()).Refused);

        Assert.Equal("'Mod' was skipped: installation file 'Mod.zip' is not in the downloads folder.", skipped.Message);
    }

    [Theory]
    [InlineData("installation file", "the mod manager records no installation file 'Patch.zip' for it")]
    [InlineData("game file", "game file 'Game.esm' has other bytes")]
    public void AModIsSkipped_WhenASourceItsManifestNamesThatNoLineUses_IsMissingOrHasOtherBytes(string source, string lack)
    {
        var download = Downloaded("dl/Mod.zip", ("a.nif", "a"));
        var patch = Downloaded("dl/Patch.zip", ("readme.txt", "r"));
        _folders.WithFile(Mod, "a.nif", "a");
        _folders.Manifests[Mod] = new Manifest(
            source == "installation file" ? [SourceOf(download), SourceOf(patch)] : [SourceOf(download)],
            source == "game file" ? [new ManifestSource("Game.esm", 7, "vanilla")] : [],
            [Line("a.nif", new FileProvider.FirstInstallationFile())]);

        var skipped = Assert.Single(Handler.Restore([ModFrom(Mod, download)], Instance(new OverriddenGameFile("Game.esm", 7, "patched"))).Refused);

        Assert.Equal($"'Mod' was skipped: {lack}.", skipped.Message);
    }

    [Fact]
    public void AFileComesBackFromASolidSevenZipsEntry()
    {
        var copy = new string('a', 8192);
        _folders.WithFile(Mod, "meshes/a.nif", "edited").WithBytes(string.Empty, "dl/Mod.7z", Convert.FromBase64String(SolidSevenZipOfReadmeAndMeshes));
        var download = new InstallationFile("dl/Mod.7z", null, 231, "#7z", [new HashedEntry("readme.txt", "abc"), new HashedEntry("meshes/a.nif", copy)]);
        Manifested(Mod, [download], Line("meshes/a.nif", new FileProvider.FirstInstallationFile()));

        Handler.Restore([ModFrom(Mod, download)], Instance());

        Assert.Equal(copy, WrittenText(Mod, "meshes/a.nif"));
    }

    [Fact]
    public void AFileComesBackFromAnEntryNamedWithBackslashes()
    {
        _folders.WithFile(Mod, "meshes/a.nif", "edited").WithBytes(string.Empty, "dl/Mod.zip", Zip(("meshes\\a.nif", "a"u8.ToArray())));
        var download = new InstallationFile("dl/Mod.zip", null, 7, "#zip", [new HashedEntry("meshes/a.nif", "a")]);
        Manifested(Mod, [download], Line("meshes/a.nif", new FileProvider.FirstInstallationFile()));

        Handler.Restore([ModFrom(Mod, download)], Instance());

        Assert.Equal("a", WrittenText(Mod, "meshes/a.nif"));
    }

    [Fact]
    public void AnInstallationFileThatIsNoArchive_LeavesTheModNotFinished_NamingIt_PromisingNoRetryMends_AndTheOthersLand()
    {
        _folders.WithFile(Mod, "a.nif", "edited").WithFile(string.Empty, "dl/Mod.zip", "not an archive");
        var download = new InstallationFile("dl/Mod.zip", null, 14, "#zip", [new HashedEntry("a.nif", "a")]);
        Manifested(Mod, [download], Line("a.nif", new FileProvider.FirstInstallationFile()));

        var result = Handler.Restore([ModFrom(Mod, download), AnotherModThatLands()], Instance());

        var unfinished = Assert.Single(result.Refused);
        Assert.Equal(RestoreRefusal.NotFinished, unfinished.Refusal.Kind);
        Assert.StartsWith("'Mod' was not finished: 'Mod.zip' is not an archive restore from manifest can read:", unfinished.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("again", unfinished.Message, StringComparison.Ordinal);
        Assert.Equal("Other", Assert.Single(result.Landed).Item);
    }

    [Fact]
    public void AModLackingAGameFileWithOtherBytesToo_IsLacking_AndNamesNothingToSendAgain()
    {
        _folders.WithFile(Mod, "meta.ini", "[General]");
        _folders.Manifests[Mod] = new Manifest(
            [], [new ManifestSource("Game.esm", 7, "vanilla"), new ManifestSource("Other.esm", 5, "other")],
            [Line("Game.esm", new FileProvider.GameFile("Game.esm")), Line("Other.esm", new FileProvider.GameFile("Other.esm"))]);

        var skipped = Assert.Single(Handler.Restore([ModFrom(Mod)], Instance(new OverriddenGameFile("Game.esm", 7, "patched"))).Refused);

        Assert.Equal(RestoreRefusal.Lacking, skipped.Refusal.Kind);
        Assert.Empty(skipped.Refusal.GameFilesNotFound);
    }

    [Fact]
    public void AModMissingSeveralSources_NamesEachOnce()
    {
        _folders.WithFile(Mod, "a.nif", "edited").WithFile(Mod, "b.nif", "edited");
        _folders.Manifests[Mod] = new Manifest(
            [new ManifestSource("Mod.zip", 7, "#dl/Mod.zip")], [],
            [Line("a.nif", new FileProvider.FirstInstallationFile()), Line("b.nif", new FileProvider.FirstInstallationFile()), Line("c.nif", new FileProvider.NoProvider())]);

        var skipped = Assert.Single(Handler.Restore([ModFrom(Mod)], Instance()).Refused);

        Assert.Equal("'Mod' was skipped: the mod manager records no installation file 'Mod.zip' for it; 'c.nif' has no provider.", skipped.Message);
    }

    [Fact]
    public void AModWithNoManifest_IsSkippedSayingSo()
    {
        _folders.WithFile(Mod, "a.nif", "a");

        var skipped = Assert.Single(Handler.Restore([ModFrom(Mod)], Instance()).Refused);

        Assert.Equal((RestoreRefusal.NoManifest, "'Mod' was skipped: it has no manifest."), (skipped.Refusal.Kind, skipped.Message));
    }

    [Fact]
    public void AModWhoseManifestCannotBeRead_IsSkippedNamingTheLine()
    {
        _folders.WithFile(Mod, "a.nif", "a");
        _folders.UnreadableManifests.Add(Mod);

        var skipped = Assert.Single(Handler.Restore([ModFrom(Mod)], Instance()).Refused);

        Assert.Equal((RestoreRefusal.ManifestUnreadable, "'Mod' was skipped: its manifest cannot be read at line 1."), (skipped.Refusal.Kind, skipped.Message));
    }

    [Fact]
    public void AWriteThatFailsPartWay_SaysTheModWasNotFinished_AndTheOthersLand()
    {
        var download = Downloaded("dl/Mod.zip", ("a.nif", "a"), ("b.nif", "b"));
        _folders.WithFile(Mod, "a.nif", "edited").WithFile(Mod, "b.nif", "edited");
        Manifested(Mod, [download], Line("a.nif", new FileProvider.FirstInstallationFile()), Line("b.nif", new FileProvider.FirstInstallationFile()));
        _folders.UnwritableFiles.Add((Mod, "b.nif"));

        var result = Handler.Restore([ModFrom(Mod, download), AnotherModThatLands()], Instance());

        var unfinished = Assert.Single(result.Refused);
        Assert.Equal(
            (RestoreRefusal.NotFinished, "'Mod' was not finished: b.nif is held by another process. Restoring it again finishes it."),
            (unfinished.Refusal.Kind, unfinished.Message));
        Assert.Equal("a", WrittenText(Mod, "a.nif"));
        Assert.Equal("Other", Assert.Single(result.Landed).Item);
    }

    [Fact]
    public void ProgressNamesItsGestureAndEachModInFlight_ThenGoesIdle()
    {
        _folders.WithFile("mods/A", "a.txt", "hello").WithFile("mods/B", "a.txt", "hello");

        Handler.Restore([ModFrom("mods/A"), ModFrom("mods/B")], Instance(), "g");

        Assert.Equal(
            [new ModlistProgress("g", "A", 0, 2), new ModlistProgress("g", "B", 1, 2), new ModlistProgress("g", null, 0, 0)], Progress);
    }
}
