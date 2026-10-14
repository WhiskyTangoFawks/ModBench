using System.IO.Compression;
using System.Text;
using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.ModFolderAdapter;
using MEditService.Ports;
using MEditService.TestSupport;
using Octodiff.Core;
using Octodiff.Diagnostics;

namespace MEditService.Commands.Tests.Build;

public sealed class RestoreFromManifestHandlerTests
{
    private const string Mod = "mods/Mod";
    private const string Other = "mods/Other";
    private const string DataFolder = "game/Data";
    private const string BuildFolder = "build";
    private const string Downloads = "downloads";

    private static readonly string Original = string.Concat(Enumerable.Range(0, 1000).Select(line => $"{line:D7}\n"));
    private static readonly string Edited = Original.Replace("0000500", "edited!", StringComparison.Ordinal);

    private readonly FakeModFolders _folders = new();
    private readonly InMemoryNotificationPublisher _notifications = new();

    private RestoreFromManifestHandler Handler => new(_folders, _notifications);

    private static InstanceToRestore Instance(IReadOnlyList<OverriddenGameFile>? gameFiles = null, IReadOnlyList<InstallationFile>? downloadedFiles = null) =>
        new(gameFiles ?? [], DataFolder, BuildFolder, Downloads, downloadedFiles ?? []);

    private static ModToRestore ModFrom(string folder, params InstallationFile[] installationFiles) =>
        new(folder[(folder.LastIndexOf('/') + 1)..], folder, installationFiles);

    private InstallationFile Downloaded(string path, params (string Path, string Text)[] entries) =>
        DownloadedBytes(path, [.. entries.Select(e => (e.Path, Encoding.ASCII.GetBytes(e.Text)))]);

    private InstallationFile DownloadedBytes(string path, params (string Path, byte[] Bytes)[] entries)
    {
        _folders.WithBytes(string.Empty, path, Zip(entries));
        return new InstallationFile(path, Source: null, Size: 7, Hash: $"#{path}", [.. entries.Select(e => new HashedEntry(e.Path, Encoding.ASCII.GetString(e.Bytes)))]);
    }

    private static ManifestSource SourceOf(InstallationFile file) => new(file.Path[(file.Path.LastIndexOf('/') + 1)..], file.Size, file.Hash);

    private static ManifestFile Line(string path, string hash, FileProvider provider) => new(path, hash, null, provider);

    private void Manifested(string folder, IReadOnlyList<InstallationFile> installationFiles, params ManifestFile[] files) =>
        _folders.Manifests[folder] = new Manifest([.. installationFiles.Select(SourceOf)], [], files);

    private void ManifestedWithGameFile(string folder, OverriddenGameFile gameFile, params ManifestFile[] files) =>
        _folders.Manifests[folder] = new Manifest([], [new ManifestSource(gameFile.Path, gameFile.Size, gameFile.Hash)], files);

    private string? WrittenText(string folder, string path) =>
        _folders.Written.TryGetValue((folder, path), out var bytes) ? Encoding.ASCII.GetString(bytes) : null;

    private IEnumerable<(string Folder, string Path)> WrittenIn(string folder) => _folders.Written.Keys.Where(key => key.Folder == folder);

    private IEnumerable<ModlistProgress> Progress =>
        _notifications.Notifications.OfType<RestoreFromManifestProgressNotification>().Select(n => n.Progress);

    private static byte[] Delta(string basis, string file)
    {
        using var signature = new MemoryStream();
        new SignatureBuilder().Build(new MemoryStream(Encoding.ASCII.GetBytes(basis)), new SignatureWriter(signature));
        signature.Position = 0;
        using var delta = new MemoryStream();
        new DeltaBuilder().BuildDelta(
            new MemoryStream(Encoding.ASCII.GetBytes(file)), new SignatureReader(signature, new NullProgressReporter()),
            new AggregateCopyOperationsDecorator(new BinaryDeltaWriter(delta)));
        return delta.ToArray();
    }

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
        Manifested(Other, [download], Line("o.txt", "o", new FileProvider.FirstInstallationFile()));
        return ModFrom(Other, download);
    }

    [Fact]
    public void AFileWhoseBytesDiffer_ComesBackFromItsInstallationFile_AndEveryOtherFileIsLeftAlone()
    {
        var download = Downloaded("dl/Mod.zip", ("a.nif", "a"), ("b.nif", "b"));
        _folders.WithFile(Mod, "a.nif", "edited").WithFile(Mod, "b.nif", "b").WithFile(Mod, "untracked.txt", "mine");
        Manifested(Mod, [download], Line("a.nif", "a", new FileProvider.FirstInstallationFile()), Line("b.nif", "b", new FileProvider.FirstInstallationFile()));

        var result = Handler.Restore([ModFrom(Mod, download)], Instance());

        Assert.Equal(["a.nif"], Assert.Single(result.Landed).Outcome.Written);
        Assert.Equal([(Mod, "a.nif")], WrittenIn(Mod));
        Assert.Equal("a", WrittenText(Mod, "a.nif"));
    }

    [Fact]
    public void AModWhoseFilesAllMatch_LandsHavingWrittenNothing_AndOpensNoInstallationFile()
    {
        var download = Downloaded("dl/Mod.zip", ("a.nif", "a"));
        _folders.WithFile(Mod, "a.nif", "a");
        Manifested(Mod, [download], Line("a.nif", "a", new FileProvider.FirstInstallationFile()));

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
        Manifested(Mod, [first, patch], Line("meshes/a.nif", "x", new FileProvider.InstallationFileEntry("Patch.zip", "Meshes/A.nif")));

        Handler.Restore([ModFrom(Mod, first, patch)], Instance());

        Assert.Equal("x", WrittenText(Mod, "meshes/a.nif"));
    }

    [Fact]
    public void OneEntryProvidingTwoFiles_WritesBoth()
    {
        var download = Downloaded("dl/Mod.zip", ("a.nif", "a"));
        _folders.WithFile(Mod, "meta.ini", "[General]");
        Manifested(Mod, [download],
            Line("a.nif", "a", new FileProvider.FirstInstallationFile()), Line("copy/a.nif", "a", new FileProvider.InstallationFileEntry("Mod.zip", "a.nif")));

        Handler.Restore([ModFrom(Mod, download)], Instance());

        Assert.Equal(("a", "a"), (WrittenText(Mod, "a.nif"), WrittenText(Mod, "copy/a.nif")));
    }

    [Fact]
    public void AFileAGameFileProvides_ComesBackFromTheGameFolder()
    {
        var game = new OverriddenGameFile("Game.esm", 7, "vanilla");
        _folders.WithFile(DataFolder, "Game.esm", "vanilla").WithFile(Mod, "game.esm", "dirty");
        ManifestedWithGameFile(Mod, game, Line("game.esm", "vanilla", new FileProvider.GameFile("Game.esm")));

        Handler.Restore([ModFrom(Mod)], Instance([game]));

        Assert.Equal("vanilla", WrittenText(Mod, "game.esm"));
    }

    [Theory]
    [InlineData("the build folder")]
    [InlineData("the downloads folder, loose")]
    [InlineData("a downloaded file")]
    public void AnEditedFile_ComesBackThroughItsDelta_FoundIn(string place)
    {
        var download = Downloaded("dl/Mod.zip", ("edited.txt", Original));
        List<InstallationFile> downloadedFiles = [];
        var name = _folders.DeltaName("edited.txt", Original, Edited);
        switch (place)
        {
            case "the build folder":
                _folders.Deltas[(BuildFolder, "edited.txt", Original, Edited)] = Delta(Original, Edited);
                break;
            case "the downloads folder, loose":
                _folders.WithBytes(Downloads, name, Delta(Original, Edited));
                break;
            default:
                downloadedFiles.Add(DownloadedBytes("dl/Deltas.zip", ($"deltas/{name}", Delta(Original, Edited))));
                break;
        }
        _folders.WithFile(Mod, "edited.txt", Original);
        Manifested(Mod, [download], Line("edited.txt", Edited, new FileProvider.InstallationFileDelta("Mod.zip", "edited.txt", Original)));

        var result = Handler.Restore([ModFrom(Mod, download)], Instance(downloadedFiles: downloadedFiles));

        Assert.Empty(result.Refused);
        Assert.Equal(Edited, WrittenText(Mod, "edited.txt"));
    }

    [Fact]
    public void APluginCleanedFromTheGamesOwn_ComesBackThroughItsDeltaFromTheGameFile()
    {
        var game = new OverriddenGameFile("Game.esm", 7, Original);
        _folders.WithFile(DataFolder, "Game.esm", Original).WithFile(Mod, "meta.ini", "[General]");
        _folders.Deltas[(BuildFolder, "Game.esm", Original, Edited)] = Delta(Original, Edited);
        ManifestedWithGameFile(Mod, game, Line("Game.esm", Edited, new FileProvider.GameFileDelta("Game.esm", Original)));

        Handler.Restore([ModFrom(Mod)], Instance([game]));

        Assert.Equal(Edited, WrittenText(Mod, "Game.esm"));
    }

    [Theory]
    [InlineData("installation file not handed", RestoreRefusal.Lacking, "installation file 'Mod.zip' is not in the downloads folder")]
    [InlineData("installation file gone", RestoreRefusal.Lacking, "installation file 'Mod.zip' is not in the downloads folder")]
    [InlineData("installation file changed", RestoreRefusal.Lacking, "installation file 'Mod.zip' has other bytes")]
    [InlineData("game file not found", RestoreRefusal.NotFound, "game file 'Game.esm' is missing")]
    [InlineData("game file changed", RestoreRefusal.Lacking, "game file 'Game.esm' has other bytes")]
    [InlineData("no provider", RestoreRefusal.Lacking, "'mine.txt' has no provider")]
    [InlineData("delta missing", RestoreRefusal.NotFound, "delta 'edited.txt.<Original>_<Edited>.octodiff' is missing")]
    public void AModThatLacksASource_IsSkippedNamingIt_WritesNothing_AndTheOthersLand(string cause, RestoreRefusal refusal, string lack)
    {
        var download = Downloaded("dl/Mod.zip", ("a.nif", "a"), ("edited.txt", Original));
        var game = new OverriddenGameFile("Game.esm", 7, "vanilla");
        _folders.WithFile(DataFolder, "Game.esm", "vanilla");
        _folders.WithFile(Mod, "a.nif", "edited").WithFile(Mod, "game.esm", "dirty").WithFile(Mod, "mine.txt", "changed").WithFile(Mod, "edited.txt", Original);
        ManifestFile[] lines = cause switch
        {
            "no provider" => [Line("mine.txt", "mine", new FileProvider.NoProvider())],
            "delta missing" => [Line("edited.txt", Edited, new FileProvider.InstallationFileDelta("Mod.zip", "edited.txt", Original))],
            "game file not found" or "game file changed" => [Line("game.esm", "vanilla", new FileProvider.GameFile("Game.esm"))],
            _ => [],
        };
        _folders.Manifests[Mod] = new Manifest(
            [SourceOf(download)], [new ManifestSource("Game.esm", 7, "vanilla")],
            [Line("a.nif", "a", new FileProvider.FirstInstallationFile()), .. lines]);
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
        Assert.Equal($"'Mod' was skipped: {lack.Replace("<Original>", Original).Replace("<Edited>", Edited)}.", skipped.Message);
        Assert.Empty(WrittenIn(Mod));
        Assert.Equal("Other", Assert.Single(result.Landed).Item);
    }

    [Fact]
    public void AModLackingOnlyGameFilesAndDeltasNotHanded_NamesEach_SoARequestNamingThemBringsItBack()
    {
        var download = Downloaded("dl/Mod.zip", ("edited.txt", Original));
        _folders.WithFile(Mod, "meta.ini", "[General]");
        _folders.Manifests[Mod] = new Manifest(
            [SourceOf(download)], [new ManifestSource("Game.esm", 7, "vanilla"), new ManifestSource("Other.esm", 5, "other")],
            [
                Line("Game.esm", "vanilla", new FileProvider.GameFile("Game.esm")),
                Line("Other.esm", "other", new FileProvider.GameFile("Other.esm")),
                Line("edited.txt", Edited, new FileProvider.InstallationFileDelta("Mod.zip", "edited.txt", Original)),
            ]);

        var skipped = Assert.Single(Handler.Restore([ModFrom(Mod, download)], Instance()).Refused);

        Assert.Equal(RestoreRefusal.NotFound, skipped.Refusal.Kind);
        Assert.Equal(["Game.esm", "Other.esm"], skipped.Refusal.GameFilesNotFound);
        Assert.Equal([_folders.DeltaName("edited.txt", Original, Edited)], skipped.Refusal.DeltasNotFound);
    }

    [Fact]
    public void AModLackingAGameFileWithOtherBytesToo_IsLacking_AndNamesNothingToSendAgain()
    {
        _folders.WithFile(Mod, "meta.ini", "[General]");
        _folders.Manifests[Mod] = new Manifest(
            [], [new ManifestSource("Game.esm", 7, "vanilla"), new ManifestSource("Other.esm", 5, "other")],
            [Line("Game.esm", "vanilla", new FileProvider.GameFile("Game.esm")), Line("Other.esm", "other", new FileProvider.GameFile("Other.esm"))]);

        var skipped = Assert.Single(Handler.Restore([ModFrom(Mod)], Instance([new OverriddenGameFile("Game.esm", 7, "patched")])).Refused);

        Assert.Equal(RestoreRefusal.Lacking, skipped.Refusal.Kind);
        Assert.Empty(skipped.Refusal.GameFilesNotFound);
    }

    [Fact]
    public void AFileWithNoProvider_WhoseBytesMatch_LacksNothing()
    {
        _folders.WithFile(Mod, "mine.txt", "mine");
        Manifested(Mod, [], Line("mine.txt", "mine", new FileProvider.NoProvider()));

        var result = Handler.Restore([ModFrom(Mod)], Instance());

        Assert.Equal("Mod", Assert.Single(result.Landed).Item);
    }

    [Fact]
    public void AModMissingSeveralSources_NamesEachOnce()
    {
        _folders.WithFile(Mod, "a.nif", "edited").WithFile(Mod, "b.nif", "edited");
        _folders.Manifests[Mod] = new Manifest(
            [new ManifestSource("Mod.zip", 7, "#dl/Mod.zip")], [],
            [Line("a.nif", "a", new FileProvider.FirstInstallationFile()), Line("b.nif", "b", new FileProvider.FirstInstallationFile()), Line("c.nif", "c", new FileProvider.NoProvider())]);

        var skipped = Assert.Single(Handler.Restore([ModFrom(Mod)], Instance()).Refused);

        Assert.Equal("'Mod' was skipped: installation file 'Mod.zip' is not in the downloads folder; 'c.nif' has no provider.", skipped.Message);
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

    [Theory]
    [InlineData("bytes that are no delta")]
    [InlineData("a delta that makes another file")]
    public void ADeltaWithOtherBytes_SkipsTheMod_AndWritesNoneOfItsFiles(string delta)
    {
        var download = Downloaded("dl/Mod.zip", ("a.nif", "a"), ("edited.txt", Original));
        _folders.Deltas[(BuildFolder, "edited.txt", Original, Edited)] =
            delta == "a delta that makes another file" ? Delta(Original, Edited.Replace("0000001", "other!!", StringComparison.Ordinal)) : [1, 2, 3];
        _folders.WithFile(Mod, "a.nif", "edited").WithFile(Mod, "edited.txt", Original);
        Manifested(Mod, [download],
            Line("a.nif", "a", new FileProvider.FirstInstallationFile()),
            Line("edited.txt", Edited, new FileProvider.InstallationFileDelta("Mod.zip", "edited.txt", Original)));

        var skipped = Assert.Single(Handler.Restore([ModFrom(Mod, download)], Instance()).Refused);

        Assert.Equal(
            (RestoreRefusal.Lacking, $"'Mod' was skipped: delta '{_folders.DeltaName("edited.txt", Original, Edited)}' has other bytes."),
            (skipped.Refusal.Kind, skipped.Message));
        Assert.Empty(WrittenIn(Mod));
    }

    [Fact]
    public void AWriteThatFailsPartWay_SaysTheModWasNotFinished_AndTheOthersLand()
    {
        var download = Downloaded("dl/Mod.zip", ("a.nif", "a"), ("b.nif", "b"));
        _folders.WithFile(Mod, "a.nif", "edited").WithFile(Mod, "b.nif", "edited");
        Manifested(Mod, [download], Line("a.nif", "a", new FileProvider.FirstInstallationFile()), Line("b.nif", "b", new FileProvider.FirstInstallationFile()));
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
    public void ProgressNamesEachModInFlight_ThenGoesIdle()
    {
        _folders.WithFile("mods/A", "a.txt", "hello").WithFile("mods/B", "a.txt", "hello");

        Handler.Restore([ModFrom("mods/A"), ModFrom("mods/B")], Instance());

        Assert.Equal([new ModlistProgress("A", 0, 2), new ModlistProgress("B", 1, 2), new ModlistProgress(null, 0, 0)], Progress);
    }
}
