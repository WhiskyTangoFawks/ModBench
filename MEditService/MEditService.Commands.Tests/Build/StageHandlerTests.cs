using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.ModFolderAdapter;
using MEditService.Ports;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Build;

public sealed class StageHandlerTests
{
    private const string Mod = "mods/Mod";

    private readonly FakeModFolders _folders = new();
    private readonly InMemoryNotificationPublisher _notifications = new();

    private StageHandler Handler => new(_folders, _notifications);

    private static ModToStage ModFrom(string name, params InstallationFile[] installationFiles) =>
        new(name, $"mods/{name}", installationFiles, []);

    private InstallationFile Downloaded(string path, params (string Path, string Hash)[] entries)
    {
        _folders.WithFile(string.Empty, path, "archive");
        return new InstallationFile(path, Source: null, Size: 7, Hash: $"#{path}", [.. entries.Select(e => new HashedEntry(e.Path, e.Hash))]);
    }

    private IEnumerable<StageProgress> Progress =>
        _notifications.Notifications.OfType<StageProgressNotification>().Select(n => n.Progress);

    private ManifestFile FileOf(string folder, string path) => _folders.Manifests[folder].Files.Single(f => f.Path == path);

    private StagedMod Landed(params ModToStage[] mods) => Landed(mods, []);

    private StagedMod Landed(IReadOnlyList<ModToStage> mods, IReadOnlyList<GameFileToStage> gameFiles)
    {
        var result = Handler.Stage(mods, gameFiles);
        Assert.Empty(result.Refused);
        return result.Landed.Single().Outcome;
    }

    [Fact]
    public void AFileTheFirstInstallationFileHoldsAtItsPath_IsTheShortLine_AndTheInstallationFileIsAsTheRequestSays()
    {
        _folders.WithFile(Mod, "meshes/a.nif", "hello", modified: 7);
        var download = Downloaded("dl/Mod.zip", ("meshes/a.nif", "hello")) with { Source = "nexus:1" };

        Landed(new ModToStage("Mod", Mod, [download], []));

        var line = FileOf(Mod, "meshes/a.nif");
        Assert.IsType<FileProvider.FirstInstallationFile>(line.Provider);
        Assert.Equal(("hello", 5L, 7L), (line.Hash, line.Stamp?.Size, line.Stamp?.Modified));
        var installationFile = Assert.Single(_folders.Manifests[Mod].InstallationFiles);
        Assert.Equal(("Mod.zip", 7L, "#dl/Mod.zip", "nexus:1"), (installationFile.Name, installationFile.Size, installationFile.Hash, installationFile.Source));
    }

    [Fact]
    public void AFileAnotherInstallationFileHoldsUnderAnotherPath_NamesThatFileAndPath()
    {
        _folders.WithFile(Mod, "a.nif", "hello");

        Landed(ModFrom("Mod", Downloaded("dl/Base.zip", ("readme.txt", "")), Downloaded("dl/Patch.zip", ("Data/a.nif", "hello"))));

        Assert.Equal(new FileProvider.InstallationFileEntry("Patch.zip", "Data/a.nif"), FileOf(Mod, "a.nif").Provider);
    }

    [Fact]
    public void AFileHeldByTwoEntries_NamesTheOneAtItsOwnPath()
    {
        _folders.WithFile(Mod, "b/same.txt", "hello");

        Landed(ModFrom(
            "Mod", Downloaded("dl/First.zip", ("elsewhere.txt", "")), Downloaded("dl/Mod.zip", ("a/same.txt", "hello"), ("b/same.txt", "hello"))));

        Assert.Equal(new FileProvider.InstallationFileEntry("Mod.zip", "b/same.txt"), FileOf(Mod, "b/same.txt").Provider);
    }

    [Fact]
    public void AFilePathedInADifferentCaseThanItsEntry_IsStillTheFirstFilesShortLine()
    {
        _folders.WithFile(Mod, "Textures/A.dds", "hello");

        Landed(ModFrom("Mod", Downloaded("dl/Mod.zip", ("textures/a.dds", "hello"))));

        Assert.IsType<FileProvider.FirstInstallationFile>(FileOf(Mod, "Textures/A.dds").Provider);
    }

    [Fact]
    public void AFileWhoseBytesDifferFromTheEntry_HasNoProvider_AndIsReported()
    {
        _folders.WithFile(Mod, "a.txt", "hellO").WithFile(Mod, "b.txt", "hello");

        var staged = Landed(ModFrom("Mod", Downloaded("dl/Mod.zip", ("a.txt", "hello"), ("b.txt", "hello"))));

        Assert.IsType<FileProvider.NoProvider>(FileOf(Mod, "a.txt").Provider);
        Assert.Equal("hellO", FileOf(Mod, "a.txt").Hash);
        Assert.Equal(["a.txt"], staged.NoProvider);
    }

    [Fact]
    public void AFileAGameFileHolds_NamesTheGameFile_AsTheRequestSaysIt()
    {
        _folders.WithFile(Mod, "game.esm", "hello").WithFile(Mod, "Other.esm", "hello");

        var staged = Landed([ModFrom("Mod")], [new GameFileToStage("Game.esm", 5, "hello"), new GameFileToStage("Other.esm", 5, "hellO")]);

        Assert.Equal(new FileProvider.GameFile("Game.esm"), FileOf(Mod, "game.esm").Provider);
        Assert.IsType<FileProvider.NoProvider>(FileOf(Mod, "Other.esm").Provider);
        Assert.Equal(["Other.esm"], staged.NoProvider);
        var gameFile = Assert.Single(_folders.Manifests[Mod].GameFiles);
        Assert.Equal(("Game.esm", 5L, "hello"), (gameFile.Name, gameFile.Size, gameFile.Hash));
    }

    [Fact]
    public void AModWithAnInstallationFileMissing_IsRefusedNamingTheModAndFile_AndTheOthersLand()
    {
        _folders.WithFile("mods/Lost", "a.txt", "hello").WithFile("mods/Found", "a.txt", "hello");
        var lost = new InstallationFile("dl/Lost.zip", null, 7, "#lost", [new HashedEntry("a.txt", "hello")]);

        var result = Handler.Stage([ModFrom("Lost", lost), ModFrom("Found", Downloaded("dl/Found.zip", ("a.txt", "hello")))], []);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(("Lost", StageRefusal.InstallationFileMissing), (refused.Item, refused.Refusal));
        Assert.Equal("'Lost' was not staged: 'Lost.zip' not in the downloads folder.", refused.Message);
        Assert.False(_folders.Manifests.ContainsKey("mods/Lost"));
        Assert.Equal(["Found"], result.Landed.Select(l => l.Item));
    }

    [Fact]
    public void AModWhoseFolderIsGone_IsRefused()
    {
        var refused = Assert.Single(Handler.Stage([ModFrom("Gone")], []).Refused);

        Assert.Equal(StageRefusal.ModFolderMissing, refused.Refusal);
    }

    [Fact]
    public void AModStagedTwice_WritesItsManifestOnce()
    {
        _folders.WithFile(Mod, "a.txt", "hello");

        var first = Landed(ModFrom("Mod"));
        var second = Landed(ModFrom("Mod"));

        Assert.True(first.ManifestWritten);
        Assert.False(second.ManifestWritten);
    }

    [Fact]
    public void AFileOfAModThatCannotBeRead_RefusesThatModNamingTheFile_AndTheOthersLand()
    {
        _folders.WithFile("mods/Held", "held.txt", "hello").WithFile("mods/Fine", "a.txt", "hello");
        _folders.Unreadable.Add(("mods/Held", "held.txt"));

        var result = Handler.Stage([ModFrom("Held"), ModFrom("Fine")], []);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(("Held", StageRefusal.ModFilesUnreadable), (refused.Item, refused.Refusal));
        Assert.Contains("held.txt", refused.Message);
        Assert.Equal(["Fine"], result.Landed.Select(l => l.Item));
    }

    [Fact]
    public void AManifestThatCannotBeWritten_RefusesThatMod_AndTheOthersLand()
    {
        _folders.WithFile("mods/Locked", "a.txt", "hello").WithFile("mods/Fine", "a.txt", "hello");
        _folders.UnwritableManifests.Add("mods/Locked");

        var result = Handler.Stage([ModFrom("Locked"), ModFrom("Fine")], []);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(("Locked", StageRefusal.ManifestNotWritten), (refused.Item, refused.Refusal));
        Assert.Equal(["Fine"], result.Landed.Select(l => l.Item));
    }

    [Fact]
    public void AFileTheRepositoryCommitsItself_HasNoLineAndIsNotReported()
    {
        _folders.WithFile(Mod, "meta.ini", "hello").WithFile(Mod, "a.txt", "hello");

        var staged = Landed(ModFrom("Mod") with { CommittedFiles = ["meta.ini"] });

        Assert.Equal(["a.txt"], _folders.Manifests[Mod].Files.Select(f => f.Path));
        Assert.Equal(["a.txt"], staged.NoProvider);
    }

    [Fact]
    public void AModNamedTwice_IsStagedOnce()
    {
        _folders.WithFile(Mod, "a.txt", "hello");

        var result = Handler.Stage([ModFrom("Mod"), ModFrom("MOD")], []);

        Assert.Single(result.Landed);
    }

    [Fact]
    public void ProgressNamesEachModInFlight_ThenGoesIdle()
    {
        _folders.WithFile("mods/A", "a.txt", "hello").WithFile("mods/B", "a.txt", "hello");

        Handler.Stage([ModFrom("A"), ModFrom("B")], []);

        Assert.Equal(
            [new StageProgress("A", 0, 2), new StageProgress("B", 1, 2), new StageProgress(null, 0, 0)],
            Progress);
    }

    [Fact]
    public void ProgressGoesIdle_WhenTheStageIsCancelled()
    {
        _folders.WithFile(Mod, "a.txt", "hello");
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();

        Assert.Throws<OperationCanceledException>(() => Handler.Stage([ModFrom("Mod")], [], cancelled.Token));

        Assert.Equal([new StageProgress(null, 0, 0)], Progress);
    }

    [Fact]
    public void AFileDeletedFromTheModFolder_LeavesTheManifest()
    {
        var handler = Handler;
        _folders.WithFile(Mod, "a.txt", "hello").WithFile(Mod, "b.txt", "hello");
        handler.Stage([ModFrom("Mod")], []);

        _folders.Without(Mod, "b.txt");
        handler.Stage([ModFrom("Mod")], []);

        Assert.Equal(["a.txt"], _folders.Manifests[Mod].Files.Select(f => f.Path));
    }
}
