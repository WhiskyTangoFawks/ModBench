using System.IO.Compression;
using System.Text;
using MEditService.Commands.Engine;
using MEditService.Commands.Tests.TestSupport;
using MEditService.ModFolderAdapter;
using MEditService.Ports;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;

namespace MEditService.Commands.Tests.Engine;

public sealed class StageHandlerTests
{
    private const string SolidSevenZipOfReadmeAndMeshes =
        "N3q8ryccAASFw+b/iQAAAAAAAAAhAAAAAAAAAK4I884BAAdoZWxsb2FiYwAAAIEzB64PzpwGxQkqrtOqhSYoExi7AyVngQOezpXEuqLOOoBYsuFpeARf9NpgbpmG3b+bdRTEowyJRFK25qT5PK7zQvu4KHFnhr9zmjxOQ7xeo5AN1N93PPjN90VRVAkntNgibYgKm0tJNViYtf0deiHHsbke5Gci3AAAABcGDAEJfQAHCwEAASMDAQEFXQAQAAAMgKIKAVdAT/MAAA==";

    private const string HashOfHello = "o22fiH2CxyY=";
    private const string HashOfHelloWithACapitalO = "0RePZfC1RR4=";
    private const string HashOfTheSevenZip = "2CdTm3mqa6A=";

    private const string Mod = "mods/Mod";
    private const string Game = "game";

    private readonly FakeModFolders _folders = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly FakeTimeProvider _time = new(DateTimeOffset.UnixEpoch.AddDays(1));

    private StageHandler Handler => new(_folders, _notifications, _time);

    private static ModToStage ModFrom(string name, params string[] installationFiles) =>
        new(name, $"mods/{name}", [.. installationFiles.Select(path => new InstallationFileToStage(path, Source: null))]);

    private IEnumerable<StageProgress> Progress =>
        _notifications.Notifications.OfType<StageProgressNotification>().Select(n => n.Progress);

    private ManifestFile FileOf(string folder, string path) => _folders.Manifests[folder].Files.Single(f => f.Path == path);

    private StagedMod Landed(params ModToStage[] mods)
    {
        var result = Handler.Stage(mods, Game);
        Assert.Empty(result.Refused);
        return result.Landed.Single().Outcome;
    }

    [Fact]
    public void AFileTheFirstInstallationFileHoldsAtItsPath_IsTheShortLine()
    {
        _folders.WithFile(Mod, "meshes/a.nif", "hello", modified: 7);
        _folders.WithBytes(string.Empty, "dl/Mod.zip", Zip(("meshes/a.nif", "hello")));

        Landed(new ModToStage("Mod", Mod, [new InstallationFileToStage("dl/Mod.zip", "nexus:1")]));

        var line = FileOf(Mod, "meshes/a.nif");
        Assert.IsType<FileProvider.FirstInstallationFile>(line.Provider);
        Assert.Equal(HashOfHello, line.Hash);
        Assert.Equal((5L, 7L), (line.Stamp?.Size, line.Stamp?.Modified));
        var installationFile = Assert.Single(_folders.Manifests[Mod].InstallationFiles);
        Assert.Equal(("Mod.zip", "nexus:1"), (installationFile.Name, installationFile.Source));
    }

    [Fact]
    public void AFileAnotherInstallationFileHoldsUnderAnotherPath_NamesThatFileAndPath()
    {
        _folders.WithFile(Mod, "a.nif", "hello");
        _folders.WithBytes(string.Empty, "dl/Base.zip", Zip(("readme.txt", "")));
        _folders.WithBytes(string.Empty, "dl/Patch.zip", Zip(("Data/a.nif", "hello")));

        Landed(ModFrom("Mod", "dl/Base.zip", "dl/Patch.zip"));

        Assert.Equal(new FileProvider.InstallationFileEntry("Patch.zip", "Data/a.nif"), FileOf(Mod, "a.nif").Provider);
    }

    [Fact]
    public void AFileHeldByTwoEntries_NamesTheOneAtItsOwnPath()
    {
        _folders.WithFile(Mod, "b/same.txt", "hello");
        _folders.WithBytes(string.Empty, "dl/Mod.zip", Zip(("a/same.txt", "hello"), ("b/same.txt", "hello")));
        _folders.WithBytes(string.Empty, "dl/First.zip", Zip(("elsewhere.txt", "")));

        Landed(ModFrom("Mod", "dl/First.zip", "dl/Mod.zip"));

        Assert.Equal(new FileProvider.InstallationFileEntry("Mod.zip", "b/same.txt"), FileOf(Mod, "b/same.txt").Provider);
    }

    [Fact]
    public void AFilePathedInADifferentCaseThanItsEntry_IsStillTheFirstFilesShortLine()
    {
        _folders.WithFile(Mod, "Textures/A.dds", "hello");
        _folders.WithBytes(string.Empty, "dl/Mod.zip", Zip(("textures/a.dds", "hello")));

        Landed(ModFrom("Mod", "dl/Mod.zip"));

        Assert.IsType<FileProvider.FirstInstallationFile>(FileOf(Mod, "Textures/A.dds").Provider);
    }

    [Fact]
    public void AFileWhoseBytesDifferFromTheEntry_HasNoProvider_AndIsReported()
    {
        _folders.WithFile(Mod, "a.txt", "hellO").WithFile(Mod, "b.txt", "hello");
        _folders.WithBytes(string.Empty, "dl/Mod.zip", Zip(("a.txt", "hello"), ("b.txt", "hello")));

        var staged = Landed(ModFrom("Mod", "dl/Mod.zip"));

        Assert.IsType<FileProvider.NoProvider>(FileOf(Mod, "a.txt").Provider);
        Assert.Equal(HashOfHelloWithACapitalO, FileOf(Mod, "a.txt").Hash);
        Assert.Equal(["a.txt"], staged.NoProvider);
    }

    [Fact]
    public void AFileTheGameDataFolderHolds_NamesTheGameFile()
    {
        _folders.WithFile(Mod, "Game.esm", "hello").WithFile(Mod, "Other.esm", "hello");
        _folders.WithFile(Game, "Game.esm", "hello").WithFile(Game, "Other.esm", "hellO");

        var staged = Landed(ModFrom("Mod"));

        Assert.Equal(new FileProvider.GameFile("Game.esm"), FileOf(Mod, "Game.esm").Provider);
        Assert.IsType<FileProvider.NoProvider>(FileOf(Mod, "Other.esm").Provider);
        Assert.Equal(["Other.esm"], staged.NoProvider);
        var gameFile = Assert.Single(_folders.Manifests[Mod].GameFiles);
        Assert.Equal(("Game.esm", 5L, HashOfHello), (gameFile.Name, gameFile.Size, gameFile.Hash));
    }

    [Fact]
    public void AnEmptyFile_IsNotProvidedByADirectoryEntry()
    {
        _folders.WithFile(Mod, "empty.txt", "");
        _folders.WithBytes(string.Empty, "dl/Mod.zip", Zip(("meshes/", ""), ("readme.txt", "hello")));

        Landed(ModFrom("Mod", "dl/Mod.zip"));

        Assert.IsType<FileProvider.NoProvider>(FileOf(Mod, "empty.txt").Provider);
    }

    [Fact]
    public void AnEntryNamedWithBackslashes_IsHeldAtItsSlashedPath()
    {
        _folders.WithFile(Mod, "meshes/a.nif", "hello");
        _folders.WithBytes(string.Empty, "dl/Mod.zip", Zip(("meshes\\a.nif", "hello")));

        Landed(ModFrom("Mod", "dl/Mod.zip"));

        Assert.IsType<FileProvider.FirstInstallationFile>(FileOf(Mod, "meshes/a.nif").Provider);
    }

    [Fact]
    public void ASolidSevenZipInstallationFile_ProvidesItsEntries_AndIsHashedWhole()
    {
        _folders.WithFile(Mod, "meshes/a.nif", "hello");
        _folders.WithBytes(string.Empty, "dl/Mod.7z", Convert.FromBase64String(SolidSevenZipOfReadmeAndMeshes));

        Landed(ModFrom("Mod", "dl/Mod.7z"));

        Assert.IsType<FileProvider.FirstInstallationFile>(FileOf(Mod, "meshes/a.nif").Provider);
        var installationFile = Assert.Single(_folders.Manifests[Mod].InstallationFiles);
        Assert.Equal((202L, HashOfTheSevenZip), (installationFile.Size, installationFile.Hash));
    }

    [Fact]
    public void AModWithAnInstallationFileMissing_IsRefusedNamingTheModAndFile_AndTheOthersLand()
    {
        _folders.WithFile("mods/Lost", "a.txt", "hello").WithFile("mods/Found", "a.txt", "hello");
        _folders.WithBytes(string.Empty, "dl/Found.zip", Zip(("a.txt", "hello")));

        var result = Handler.Stage([ModFrom("Lost", "dl/Lost.zip"), ModFrom("Found", "dl/Found.zip")], Game);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(("Lost", StageRefusal.InstallationFileMissing), (refused.Item, refused.Refusal));
        Assert.Equal("'Lost' was not staged: 'Lost.zip' not in the downloads folder.", refused.Message);
        Assert.False(_folders.Manifests.ContainsKey("mods/Lost"));
        Assert.Equal(["Found"], result.Landed.Select(l => l.Item));
    }

    [Fact]
    public void AnInstallationFileThatIsNoArchive_RefusesTheModNamingTheFile()
    {
        _folders.WithFile(Mod, "a.txt", "hello");
        _folders.WithBytes(string.Empty, "dl/Mod.zip", Encoding.ASCII.GetBytes("not an archive at all"));

        var refused = Assert.Single(Handler.Stage([ModFrom("Mod", "dl/Mod.zip")], Game).Refused);

        Assert.Equal(StageRefusal.InstallationFileUnreadable, refused.Refusal);
        Assert.StartsWith("'Mod' was not staged: 'Mod.zip' cannot be read as an archive", refused.Message);
    }

    [Fact]
    public void AModWhoseFolderIsGone_IsRefused()
    {
        var refused = Assert.Single(Handler.Stage([ModFrom("Gone")], Game).Refused);

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

        var result = Handler.Stage([ModFrom("Held"), ModFrom("Fine")], Game);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(("Held", StageRefusal.ModFilesUnreadable), (refused.Item, refused.Refusal));
        Assert.Contains("held.txt", refused.Message);
        Assert.Equal(["Fine"], result.Landed.Select(l => l.Item));
    }

    [Fact]
    public void AnInstallationFileThatCannotBeOpened_RefusesThatModNamingTheFile_AndTheOthersLand()
    {
        _folders.WithFile("mods/Held", "a.txt", "hello").WithFile("mods/Fine", "a.txt", "hello");
        _folders.WithBytes(string.Empty, "dl/Held.zip", Zip(("a.txt", "hello")));
        _folders.Unreadable.Add((string.Empty, "dl/Held.zip"));

        var result = Handler.Stage([ModFrom("Held", "dl/Held.zip"), ModFrom("Fine")], Game);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(("Held", StageRefusal.InstallationFileUnreadable), (refused.Item, refused.Refusal));
        Assert.Contains("Held.zip", refused.Message);
        Assert.Equal(["Fine"], result.Landed.Select(l => l.Item));
    }

    [Fact]
    public void AManifestThatCannotBeWritten_RefusesThatMod_AndTheOthersLand()
    {
        _folders.WithFile("mods/Locked", "a.txt", "hello").WithFile("mods/Fine", "a.txt", "hello");
        _folders.UnwritableManifests.Add("mods/Locked");

        var result = Handler.Stage([ModFrom("Locked"), ModFrom("Fine")], Game);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(("Locked", StageRefusal.ManifestNotWritten), (refused.Item, refused.Refusal));
        Assert.Equal(["Fine"], result.Landed.Select(l => l.Item));
    }

    [Fact]
    public void AModNamedTwice_IsStagedOnce()
    {
        _folders.WithFile(Mod, "a.txt", "hello");

        var result = Handler.Stage([ModFrom("Mod"), ModFrom("MOD")], Game);

        Assert.Single(result.Landed);
    }

    [Fact]
    public void ProgressNamesEachModInFlight_ThenGoesIdle()
    {
        _folders.WithFile("mods/A", "a.txt", "hello").WithFile("mods/B", "a.txt", "hello");

        Handler.Stage([ModFrom("A"), ModFrom("B")], Game);

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

        Assert.Throws<OperationCanceledException>(() => Handler.Stage([ModFrom("Mod")], Game, cancelled.Token));

        Assert.Equal([new StageProgress(null, 0, 0)], Progress);
    }

    [Theory]
    [InlineData(1, 0)]
    [InlineData(0, 1)]
    public void AFileStillStampedAsBefore_IsNotReadAgain_AndOneStampedAnew_IsHashedAgain(long modified, long changed)
    {
        var handler = Handler;
        _folders.WithFile(Mod, "a.txt", "hello");
        handler.Stage([ModFrom("Mod")], Game);
        Assert.Equal(1, _folders.Opens);

        handler.Stage([ModFrom("Mod")], Game);
        Assert.Equal(1, _folders.Opens);

        _folders.WithFile(Mod, "a.txt", "hellO", modified: modified, changed: changed);
        handler.Stage([ModFrom("Mod")], Game);

        Assert.Equal(2, _folders.Opens);
        Assert.Equal(HashOfHelloWithACapitalO, FileOf(Mod, "a.txt").Hash);
    }

    [Fact]
    public void AFileWhoseSizeChangedAtTheSameTimes_IsHashedAgain()
    {
        var handler = Handler;
        _folders.WithFile(Mod, "a.txt", "hello");
        handler.Stage([ModFrom("Mod")], Game);

        _folders.WithFile(Mod, "a.txt", "hello!");
        handler.Stage([ModFrom("Mod")], Game);

        Assert.Equal(2, _folders.Opens);
    }

    [Fact]
    public void AFileTheFileSystemCannotStamp_IsReadEveryTime()
    {
        var handler = Handler;
        _folders.WithUnstampedFile(Mod, "a.txt", "hello");

        handler.Stage([ModFrom("Mod")], Game);
        handler.Stage([ModFrom("Mod")], Game);

        Assert.Equal(2, _folders.Opens);
    }

    [Fact]
    public void AFileChangedAtTheMomentItWasRead_IsReadAgain_BecauseAWriteInTheSameTickLeavesItsStamp()
    {
        var handler = Handler;
        var justNow = (_time.GetUtcNow() - DateTimeOffset.UnixEpoch).Ticks * 100;
        _folders.WithFile(Mod, "a.txt", "hello", modified: justNow, changed: justNow);

        handler.Stage([ModFrom("Mod")], Game);
        handler.Stage([ModFrom("Mod")], Game);

        Assert.Equal(2, _folders.Opens);
        Assert.Null(FileOf(Mod, "a.txt").Stamp);
    }

    [Fact]
    public void AFileChangedLongBeforeItWasRead_IsRecordedWithItsStamp()
    {
        _folders.WithFile(Mod, "a.txt", "hello", modified: 7, changed: 7);

        Landed(ModFrom("Mod"));

        Assert.Equal((5L, 7L), (FileOf(Mod, "a.txt").Stamp?.Size, FileOf(Mod, "a.txt").Stamp?.Modified));
    }

    [Fact]
    public void AnInstallationFileStampedAsBefore_IsNotReadAgain()
    {
        var handler = Handler;
        _folders.WithFile(Mod, "a.txt", "hello");
        _folders.WithBytes(string.Empty, "dl/Mod.zip", Zip(("a.txt", "hello")));

        handler.Stage([ModFrom("Mod", "dl/Mod.zip")], Game);
        var opensAfterTheFirst = _folders.Opens;
        handler.Stage([ModFrom("Mod", "dl/Mod.zip")], Game);

        Assert.Equal(opensAfterTheFirst, _folders.Opens);
    }

    [Fact]
    public void AFileDeletedFromTheModFolder_LeavesTheManifest()
    {
        var handler = Handler;
        _folders.WithFile(Mod, "a.txt", "hello").WithFile(Mod, "b.txt", "hello");
        handler.Stage([ModFrom("Mod")], Game);

        _folders.Without(Mod, "b.txt");
        handler.Stage([ModFrom("Mod")], Game);

        Assert.Equal(["a.txt"], _folders.Manifests[Mod].Files.Select(f => f.Path));
    }

    private static byte[] Zip(params (string Path, string Text)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (path, text) in entries)
            {
                using var entry = archive.CreateEntry(path).Open();
                entry.Write(Encoding.ASCII.GetBytes(text));
            }
        }
        return buffer.ToArray();
    }
}
