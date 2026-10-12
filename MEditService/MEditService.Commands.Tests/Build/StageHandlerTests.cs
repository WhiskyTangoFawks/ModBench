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

public sealed class StageHandlerTests
{
    private const string Mod = "mods/Mod";
    private const string DataFolder = "game/Data";
    private const string BuildFolder = "build";

    private const string SolidSevenZipOfReadmeAndMeshes =
        "N3q8ryccAATuUVnEpgAAAAAAAAAhAAAAAAAAAC+dzs3gIAIAKV0AMO/7v/6jsV7l+D+yqiZV+GhwQXAVD439HkwbikK3GfRpGHAufifG/wAAAACBMweuD9EP9rigkKB3XrpXH+ax2dPvt7i58wldO1uKWgKup3uXhzzBgYN/yWVyKGG6hrzHb+8AS3A4eb6xWIpNOTGqvAgOWKrbXPL2/IPdDY8hq8YbGjaD7xEjTC7CbMP6A0APd4UmYIrlYd9r+G9HAAAAFwYxAQl1AAcLAQABIwMBAQVdABAAAAyAhgoBy3m54QAA";

    private static readonly string Original = string.Concat(Enumerable.Range(0, 1000).Select(line => $"{line:D7}\n"));
    private static readonly string Edited = Original.Replace("0000500", "edited!", StringComparison.Ordinal);

    private readonly FakeModFolders _folders = new();
    private readonly InMemoryNotificationPublisher _notifications = new();

    private StageHandler Handler => new(_folders, _notifications);

    private static InstanceToStage Instance(params GameFileToStage[] gameFiles) => new(gameFiles, DataFolder, BuildFolder, DeltaShare: 1);

    private static ModToStage ModFrom(string name, params InstallationFileToStage[] installationFiles) =>
        new(name, $"mods/{name}", installationFiles, []);

    private InstallationFileToStage Downloaded(string path, params (string Path, string Hash)[] entries)
    {
        _folders.WithBytes(string.Empty, path, Zip(entries));
        return new InstallationFileToStage(path, Source: null, Size: 7, Hash: $"#{path}", [.. entries.Select(e => new HashedEntry(e.Path, e.Hash))]);
    }

    private IEnumerable<StageProgress> Progress =>
        _notifications.Notifications.OfType<StageProgressNotification>().Select(n => n.Progress);

    private ManifestFile FileOf(string folder, string path) => _folders.Manifests[folder].Files.Single(f => f.Path == path);

    private StagedMod Landed(params ModToStage[] mods) => Landed(mods, Instance());

    private StagedMod Landed(IReadOnlyList<ModToStage> mods, InstanceToStage instance)
    {
        var result = Handler.Stage(mods, instance);
        Assert.Empty(result.Refused);
        return result.Landed.Single().Outcome;
    }

    private string DeltaAppliedAsWabbajackApplies(string path, string basis, string file)
    {
        using var output = new MemoryStream();
        new DeltaApplier().Apply(
            new MemoryStream(Encoding.ASCII.GetBytes(basis)),
            new BinaryDeltaReader(new MemoryStream(_folders.Deltas[(BuildFolder, path, basis, file)]), new NullProgressReporter()),
            output);
        return Encoding.ASCII.GetString(output.ToArray());
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

    [Fact]
    public void AFileWhoseBytesDifferFromAnInstallationFilesCopy_IsADeltaFromThatCopy_InTheBuildFolder()
    {
        _folders.WithFile(Mod, "meshes/a.nif", Edited);

        var staged = Landed(ModFrom("Mod", Downloaded("dl/Base.zip", ("readme.txt", "")), Downloaded("dl/Patch.zip", ("Meshes/A.nif", Original))));

        Assert.Equal(new FileProvider.InstallationFileDelta("Patch.zip", "Meshes/A.nif", Original), FileOf(Mod, "meshes/a.nif").Provider);
        Assert.Equal(Edited, DeltaAppliedAsWabbajackApplies("meshes/a.nif", Original, Edited));
        Assert.Empty(staged.NoProvider);
    }

    [Fact]
    public void APluginCleanedFromTheGamesOwn_IsADeltaFromTheGameFile_WhichTheManifestNames()
    {
        _folders.WithFile(Mod, "game.esm", Edited).WithFile(DataFolder, "Game.esm", Original);

        Landed([ModFrom("Mod")], Instance(new GameFileToStage("Game.esm", Original.Length, Original)));

        Assert.Equal(new FileProvider.GameFileDelta("Game.esm", Original), FileOf(Mod, "game.esm").Provider);
        Assert.Equal(Edited, DeltaAppliedAsWabbajackApplies("game.esm", Original, Edited));
        Assert.Equal(["Game.esm"], _folders.Manifests[Mod].GameFiles.Select(game => game.Name));
    }

    [Fact]
    public void ADeltaLargerThanTheShare_HasNoProvider_IsReported_AndIsNotWritten()
    {
        _folders.WithFile(Mod, "a.txt", Edited);

        var staged = Landed([ModFrom("Mod", Downloaded("dl/Mod.zip", ("a.txt", Original)))], Instance() with { DeltaShare = 0.01 });

        Assert.IsType<FileProvider.NoProvider>(FileOf(Mod, "a.txt").Provider);
        Assert.Equal(["a.txt"], staged.NoProvider);
        Assert.Empty(_folders.Deltas);
    }

    [Fact]
    public void ADeltaTheBuildFolderHolds_IsKept_AndNoFileIsOpened()
    {
        _folders.WithFile(Mod, "a.txt", Edited);
        var mod = ModFrom("Mod", Downloaded("dl/Mod.zip", ("a.txt", Original)));
        Landed(mod);
        var opened = _folders.Opens;

        Landed(mod);

        Assert.Equal(opened, _folders.Opens);
        Assert.IsType<FileProvider.InstallationFileDelta>(FileOf(Mod, "a.txt").Provider);
    }

    [Fact]
    public void ADeltaTheBuildFolderHolds_LargerThanALoweredShare_HasNoProvider()
    {
        _folders.WithFile(Mod, "a.txt", Edited);
        var mod = ModFrom("Mod", Downloaded("dl/Mod.zip", ("a.txt", Original)));
        Landed(mod);

        var staged = Landed([mod], Instance() with { DeltaShare = 0.01 });

        Assert.Equal(["a.txt"], staged.NoProvider);
    }

    [Fact]
    public void ACopyTheInstallationFileTurnsOutNotToHold_LeavesTheFileWithNoProvider()
    {
        _folders.WithFile(Mod, "a.txt", Edited).WithBytes(string.Empty, "dl/Mod.zip", Zip(("other.txt", Original)));

        var staged = Landed(ModFrom("Mod", new InstallationFileToStage("dl/Mod.zip", null, 7, "#zip", [new HashedEntry("a.txt", Original)])));

        Assert.Equal(["a.txt"], staged.NoProvider);
    }

    [Fact]
    public void ASolidSevenZipsEntry_IsACopyADeltaIsMadeFrom()
    {
        var copy = new string('a', 8192);
        var edited = copy[..4096] + "b" + copy[4097..];
        _folders.WithFile(Mod, "meshes/a.nif", edited).WithBytes(string.Empty, "dl/Mod.7z", Convert.FromBase64String(SolidSevenZipOfReadmeAndMeshes));

        Landed(ModFrom("Mod", new InstallationFileToStage(
            "dl/Mod.7z", null, 231, "#7z", [new HashedEntry("readme.txt", "abc"), new HashedEntry("meshes/a.nif", copy)])));

        Assert.Equal(edited, DeltaAppliedAsWabbajackApplies("meshes/a.nif", copy, edited));
    }

    [Fact]
    public void AnEntryNamedWithBackslashes_IsTheCopyAtItsSlashedPath()
    {
        _folders.WithFile(Mod, "meshes/a.nif", Edited).WithBytes(string.Empty, "dl/Mod.zip", Zip(("meshes\\a.nif", Original)));

        Landed(ModFrom("Mod", new InstallationFileToStage("dl/Mod.zip", null, 7, "#zip", [new HashedEntry("meshes/a.nif", Original)])));

        Assert.Equal(Edited, DeltaAppliedAsWabbajackApplies("meshes/a.nif", Original, Edited));
    }

    [Fact]
    public void AnInstallationFileThatIsNoArchive_RefusesTheModWhoseDeltaNeedsIt_AndTheOthersLand()
    {
        _folders.WithFile("mods/Broken", "a.txt", Edited).WithFile("mods/Fine", "a.txt", "hello");
        _folders.WithFile(string.Empty, "dl/Broken.zip", "not an archive");
        var broken = new InstallationFileToStage("dl/Broken.zip", null, 14, "#broken", [new HashedEntry("a.txt", Original)]);

        var result = Handler.Stage([ModFrom("Broken", broken), ModFrom("Fine")], Instance());

        var refused = Assert.Single(result.Refused);
        Assert.Equal(("Broken", StageRefusal.ModFilesUnreadable), (refused.Item, refused.Refusal));
        Assert.Contains("Broken.zip", refused.Message);
        Assert.Equal(["Fine"], result.Landed.Select(l => l.Item));
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
    public void AFileNothingHolds_WithNoCopyAtItsPath_HasNoProvider_AndIsReported()
    {
        _folders.WithFile(Mod, "a.txt", "hellO").WithFile(Mod, "b.txt", "hello");

        var staged = Landed(ModFrom("Mod", Downloaded("dl/Mod.zip", ("other/a.txt", "hello"), ("b.txt", "hello"))));

        Assert.IsType<FileProvider.NoProvider>(FileOf(Mod, "a.txt").Provider);
        Assert.Equal("hellO", FileOf(Mod, "a.txt").Hash);
        Assert.Equal(["a.txt"], staged.NoProvider);
    }

    [Fact]
    public void AFileAGameFileHolds_NamesTheGameFile_AsTheRequestSaysIt()
    {
        _folders.WithFile(Mod, "game.esm", "hello");

        Landed([ModFrom("Mod")], Instance(new GameFileToStage("Game.esm", 5, "hello")));

        Assert.Equal(new FileProvider.GameFile("Game.esm"), FileOf(Mod, "game.esm").Provider);
        var gameFile = Assert.Single(_folders.Manifests[Mod].GameFiles);
        Assert.Equal(("Game.esm", 5L, "hello"), (gameFile.Name, gameFile.Size, gameFile.Hash));
    }

    [Fact]
    public void AModWithAnInstallationFileMissing_IsRefusedNamingTheModAndFile_AndTheOthersLand()
    {
        _folders.WithFile("mods/Lost", "a.txt", "hello").WithFile("mods/Found", "a.txt", "hello");
        var lost = new InstallationFileToStage("dl/Lost.zip", null, 7, "#lost", [new HashedEntry("a.txt", "hello")]);

        var result = Handler.Stage([ModFrom("Lost", lost), ModFrom("Found", Downloaded("dl/Found.zip", ("a.txt", "hello")))], Instance());

        var refused = Assert.Single(result.Refused);
        Assert.Equal(("Lost", StageRefusal.InstallationFileMissing), (refused.Item, refused.Refusal));
        Assert.Equal("'Lost' was not staged: 'Lost.zip' not in the downloads folder.", refused.Message);
        Assert.False(_folders.Manifests.ContainsKey("mods/Lost"));
        Assert.Equal(["Found"], result.Landed.Select(l => l.Item));
    }

    [Fact]
    public void AModWhoseFolderIsGone_IsRefused()
    {
        var refused = Assert.Single(Handler.Stage([ModFrom("Gone")], Instance()).Refused);

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

        var result = Handler.Stage([ModFrom("Held"), ModFrom("Fine")], Instance());

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

        var result = Handler.Stage([ModFrom("Locked"), ModFrom("Fine")], Instance());

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

        var result = Handler.Stage([ModFrom("Mod"), ModFrom("MOD")], Instance());

        Assert.Single(result.Landed);
    }

    [Fact]
    public void ProgressNamesEachModInFlight_ThenGoesIdle()
    {
        _folders.WithFile("mods/A", "a.txt", "hello").WithFile("mods/B", "a.txt", "hello");

        Handler.Stage([ModFrom("A"), ModFrom("B")], Instance());

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

        Assert.Throws<OperationCanceledException>(() => Handler.Stage([ModFrom("Mod")], Instance(), cancelled.Token));

        Assert.Equal([new StageProgress(null, 0, 0)], Progress);
    }

    [Fact]
    public void AFileDeletedFromTheModFolder_LeavesTheManifest()
    {
        var handler = Handler;
        _folders.WithFile(Mod, "a.txt", "hello").WithFile(Mod, "b.txt", "hello");
        handler.Stage([ModFrom("Mod")], Instance());

        _folders.Without(Mod, "b.txt");
        handler.Stage([ModFrom("Mod")], Instance());

        Assert.Equal(["a.txt"], _folders.Manifests[Mod].Files.Select(f => f.Path));
    }
}
