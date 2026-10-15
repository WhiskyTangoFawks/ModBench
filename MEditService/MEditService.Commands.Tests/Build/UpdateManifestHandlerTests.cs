using System.IO.Compression;
using System.Text;
using MEditService.Commands.Build;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.ModFolderAdapter;
using MEditService.Ports;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Build;

public sealed class UpdateManifestHandlerTests
{
    private const string Mod = "mods/Mod";

    private readonly FakeModFolders _folders = new();
    private readonly InMemoryNotificationPublisher _notifications = new();

    private UpdateManifestHandler Handler => new(_folders, _notifications);

    private static ModToUpdate ModFrom(string name, params InstallationFile[] installationFiles) =>
        new(name, $"mods/{name}", installationFiles, [], IsSourceMod: false);

    private Manifest BuiltSourceMod()
    {
        _folders.WithFile(Mod, "a.esp", "built").WithFile(Mod, "z.txt", "edited");
        var built = new Manifest([], [], [
            new ManifestFile("a.esp", new FileProvider.Source("https://example.com/mod.git", "0123abc")),
            new ManifestFile("z.txt", new FileProvider.NoProvider()),
        ]);
        _folders.Manifests[Mod] = built;
        _folders.KeptProviderHashes[Mod] = new Dictionary<string, string> { ["a.esp"] = "built" };
        return built;
    }

    private static ModToUpdate SourceMod => new("Mod", Mod, [], [], IsSourceMod: true);

    private InstallationFile Downloaded(string path, params (string Path, string Hash)[] entries)
    {
        _folders.WithBytes(string.Empty, path, Zip(entries));
        return new InstallationFile(path, Source: null, Size: 7, Hash: $"#{path}", [.. entries.Select(e => new HashedEntry(e.Path, e.Hash))]);
    }

    private IEnumerable<ModlistProgress> Progress =>
        _notifications.Notifications.OfType<UpdateManifestProgressNotification>().Select(n => n.Progress);

    private ManifestFile FileOf(string folder, string path) => _folders.Manifests[folder].Files.Single(f => f.Path == path);

    private Task<SelectionResult<string, UpdateManifestRefusal, UpdatedMod>> Update(
        IReadOnlyList<ModToUpdate> mods, IReadOnlyList<OverriddenGameFile> gameFiles, string? gesture = null, CancellationToken cancel = default) =>
        Handler.UpdateManifestAsync(mods, new InstanceToUpdate(gameFiles, "stat-cache"), gesture, cancel);

    private Task<UpdatedMod> Landed(params ModToUpdate[] mods) => Landed(mods, []);

    private async Task<UpdatedMod> Landed(IReadOnlyList<ModToUpdate> mods, IReadOnlyList<OverriddenGameFile> gameFiles)
    {
        var result = await Update(mods, gameFiles);
        Assert.Empty(result.Refused);
        return result.Landed.Single().Outcome;
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
    public async Task AFileWhoseBytesDifferFromAnInstallationFilesCopy_HasNoProvider_IsReported_AndNoInstallationFileIsOpened()
    {
        _folders.WithFile(Mod, "meshes/a.nif", "edited");

        var updated = await Landed(ModFrom("Mod", Downloaded("dl/Base.zip", ("readme.txt", "")), Downloaded("dl/Patch.zip", ("Meshes/A.nif", "original"))));

        Assert.IsType<FileProvider.NoProvider>(FileOf(Mod, "meshes/a.nif").Provider);
        Assert.Equal(["meshes/a.nif"], updated.NoProvider);
        Assert.Equal(0, _folders.Opens);
    }

    [Fact]
    public async Task APluginCleanedFromTheGamesOwn_HasNoProvider_AndTheManifestNamesNoGameFile()
    {
        _folders.WithFile(Mod, "game.esm", "cleaned");

        var updated = await Landed([ModFrom("Mod")], [new OverriddenGameFile("Game.esm", 7, "vanilla")]);

        Assert.IsType<FileProvider.NoProvider>(FileOf(Mod, "game.esm").Provider);
        Assert.Equal(["game.esm"], updated.NoProvider);
        Assert.Empty(_folders.Manifests[Mod].GameFiles);
    }

    [Fact]
    public async Task AFileTheFirstInstallationFileHoldsAtItsPath_IsTheShortLine_AndTheInstallationFileIsAsTheRequestSays()
    {
        _folders.WithFile(Mod, "meshes/a.nif", "hello");
        var download = Downloaded("dl/Mod.zip", ("meshes/a.nif", "hello")) with { Source = "nexus:1" };

        await Landed(new ModToUpdate("Mod", Mod, [download], [], IsSourceMod: false));

        var line = FileOf(Mod, "meshes/a.nif");
        Assert.IsType<FileProvider.FirstInstallationFile>(line.Provider);
        var installationFile = Assert.Single(_folders.Manifests[Mod].InstallationFiles);
        Assert.Equal(("Mod.zip", 7L, "#dl/Mod.zip", "nexus:1"), (installationFile.Name, installationFile.Size, installationFile.Hash, installationFile.Source));
    }

    [Fact]
    public async Task TheModsVersion_IsInItsManifest()
    {
        _folders.WithFile(Mod, "a.txt", "hello");

        await Landed(ModFrom("Mod") with { Version = "1.2.3" });

        Assert.Equal("1.2.3", _folders.Manifests[Mod].Version);
    }

    [Fact]
    public async Task AFileAnotherInstallationFileHoldsUnderAnotherPath_NamesThatFileAndPath()
    {
        _folders.WithFile(Mod, "a.nif", "hello");

        await Landed(ModFrom("Mod", Downloaded("dl/Base.zip", ("readme.txt", "")), Downloaded("dl/Patch.zip", ("Data/a.nif", "hello"))));

        Assert.Equal(new FileProvider.InstallationFileEntry("Patch.zip", "Data/a.nif"), FileOf(Mod, "a.nif").Provider);
    }

    [Fact]
    public async Task AFileHeldByTwoEntries_NamesTheOneAtItsOwnPath()
    {
        _folders.WithFile(Mod, "b/same.txt", "hello");

        await Landed(ModFrom(
            "Mod", Downloaded("dl/First.zip", ("elsewhere.txt", "")), Downloaded("dl/Mod.zip", ("a/same.txt", "hello"), ("b/same.txt", "hello"))));

        Assert.Equal(new FileProvider.InstallationFileEntry("Mod.zip", "b/same.txt"), FileOf(Mod, "b/same.txt").Provider);
    }

    [Fact]
    public async Task AFilePathedInADifferentCaseThanItsEntry_IsStillTheFirstFilesShortLine()
    {
        _folders.WithFile(Mod, "Textures/A.dds", "hello");

        await Landed(ModFrom("Mod", Downloaded("dl/Mod.zip", ("textures/a.dds", "hello"))));

        Assert.IsType<FileProvider.FirstInstallationFile>(FileOf(Mod, "Textures/A.dds").Provider);
    }

    [Fact]
    public async Task AnUpdatedMod_KeepsInItsStatCache_EachFilesHash_AsTheHashItsProviderFixes()
    {
        _folders.WithFile(Mod, "a.txt", "hello");

        await Landed(ModFrom("Mod", Downloaded("dl/Mod.zip", ("a.txt", "hello"))));

        Assert.Equal(new Dictionary<string, string> { ["a.txt"] = "hello" }, _folders.KeptProviderHashes[Mod]);
    }

    [Fact]
    public async Task AModWhoseStatCacheCannotBeWritten_Lands_NamingWhy()
    {
        _folders.WithFile(Mod, "a.txt", "hello");
        _folders.UnwritableStatCaches.Add(Mod);

        var updated = await Landed(ModFrom("Mod"));

        Assert.True(updated.ManifestWritten);
        Assert.Equal("stat-cache is read-only", updated.StatCacheNotWritten);
    }

    [Fact]
    public async Task AFileNothingHolds_WithNoCopyAtItsPath_HasNoProvider_AndIsReported()
    {
        _folders.WithFile(Mod, "a.txt", "hellO").WithFile(Mod, "b.txt", "hello");

        var updated = await Landed(ModFrom("Mod", Downloaded("dl/Mod.zip", ("other/a.txt", "hello"), ("b.txt", "hello"))));

        Assert.IsType<FileProvider.NoProvider>(FileOf(Mod, "a.txt").Provider);
        Assert.Equal(["a.txt"], updated.NoProvider);
    }

    [Fact]
    public async Task AFileAGameFileHolds_NamesTheGameFile_AsTheRequestSaysIt()
    {
        _folders.WithFile(Mod, "game.esm", "hello");

        await Landed([ModFrom("Mod")], [new OverriddenGameFile("Game.esm", 5, "hello")]);

        Assert.Equal(new FileProvider.GameFile("Game.esm"), FileOf(Mod, "game.esm").Provider);
        var gameFile = Assert.Single(_folders.Manifests[Mod].GameFiles);
        Assert.Equal(("Game.esm", 5L, "hello"), (gameFile.Name, gameFile.Size, gameFile.Hash));
    }

    [Fact]
    public async Task AModWithAnInstallationFileMissing_IsRefusedNamingTheModAndFile_AndTheOthersLand()
    {
        _folders.WithFile("mods/Lost", "a.txt", "hello").WithFile("mods/Found", "a.txt", "hello");
        var lost = new InstallationFile("dl/Lost.zip", null, 7, "#lost", [new HashedEntry("a.txt", "hello")]);

        var result = await Update([ModFrom("Lost", lost), ModFrom("Found", Downloaded("dl/Found.zip", ("a.txt", "hello")))], []);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(("Lost", UpdateManifestRefusal.InstallationFileMissing), (refused.Item, refused.Refusal));
        Assert.Equal("'Lost' was not updated: 'Lost.zip' not in the downloads folder.", refused.Message);
        Assert.False(_folders.Manifests.ContainsKey("mods/Lost"));
        Assert.Equal(["Found"], result.Landed.Select(l => l.Item));
    }

    [Fact]
    public async Task AModWhoseFolderIsGone_IsRefused()
    {
        var refused = Assert.Single((await Update([ModFrom("Gone")], [])).Refused);

        Assert.Equal(UpdateManifestRefusal.ModFolderMissing, refused.Refusal);
    }

    [Fact]
    public async Task AModUpdatedTwice_WritesItsManifestOnce()
    {
        _folders.WithFile(Mod, "a.txt", "hello");

        var first = await Landed(ModFrom("Mod"));
        var second = await Landed(ModFrom("Mod"));

        Assert.True(first.ManifestWritten);
        Assert.False(second.ManifestWritten);
    }

    [Fact]
    public async Task AFileOfAModThatCannotBeRead_RefusesThatModNamingTheFile_AndTheOthersLand()
    {
        _folders.WithFile("mods/Held", "held.txt", "hello").WithFile("mods/Fine", "a.txt", "hello");
        _folders.Unreadable.Add(("mods/Held", "held.txt"));

        var result = await Update([ModFrom("Held"), ModFrom("Fine")], []);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(("Held", UpdateManifestRefusal.ModFilesUnreadable), (refused.Item, refused.Refusal));
        Assert.Contains("held.txt", refused.Message);
        Assert.Equal(["Fine"], result.Landed.Select(l => l.Item));
    }

    [Fact]
    public async Task AManifestThatCannotBeWritten_RefusesThatMod_AndTheOthersLand()
    {
        _folders.WithFile("mods/Locked", "a.txt", "hello").WithFile("mods/Fine", "a.txt", "hello");
        _folders.UnwritableManifests.Add("mods/Locked");

        var result = await Update([ModFrom("Locked"), ModFrom("Fine")], []);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(("Locked", UpdateManifestRefusal.NotWritten), (refused.Item, refused.Refusal));
        Assert.Equal(["Fine"], result.Landed.Select(l => l.Item));
    }

    [Fact]
    public async Task AFileTheRepositoryCommitsItself_HasNoLineAndIsNotReported()
    {
        _folders.WithFile(Mod, "meta.ini", "hello").WithFile(Mod, "a.txt", "hello");

        var updated = await Landed(ModFrom("Mod") with { CommittedFiles = ["meta.ini"] });

        Assert.Equal(["a.txt"], _folders.Manifests[Mod].Files.Select(f => f.Path));
        Assert.Equal(["a.txt"], updated.NoProvider);
    }

    [Fact]
    public async Task AModNamedTwice_IsUpdatedOnce()
    {
        _folders.WithFile(Mod, "a.txt", "hello");

        var result = await Update([ModFrom("Mod"), ModFrom("MOD")], []);

        Assert.Single(result.Landed);
    }

    [Fact]
    public async Task ProgressNamesItsGestureAndEachModInFlight_ThenGoesIdle()
    {
        _folders.WithFile("mods/A", "a.txt", "hello").WithFile("mods/B", "a.txt", "hello");

        await Update([ModFrom("A"), ModFrom("B")], [], "g");

        Assert.Equal(
            [new ModlistProgress("g", "A", 0, 2), new ModlistProgress("g", "B", 1, 2), new ModlistProgress("g", null, 0, 0)],
            Progress);
    }

    [Fact]
    public async Task ACancelledUpdate_StopsAfterTheModInHand_AnswersTheModsThatLanded_AndGoesIdle()
    {
        _folders.WithFile("mods/A", "a.txt", "hello").WithFile("mods/B", "b.txt", "hello");
        using var cancel = new CancellationTokenSource();
        _notifications.OnPublish = _ => cancel.Cancel();

        var result = await Update([ModFrom("A"), ModFrom("B")], [], cancel: cancel.Token);

        Assert.Equal(["A"], result.Landed.Select(landed => landed.Item));
        Assert.Empty(result.Refused);
        Assert.Equal(new ModlistProgress(null, null, 0, 0), Progress.Last());
    }

    [Fact]
    public async Task ASourceModAsItsBuildWroteIt_Lands_LeavingItsManifest_AndReportsEachFileWithNoProvider()
    {
        var built = BuiltSourceMod();

        var updated = await Landed(SourceMod);

        Assert.Same(built, _folders.Manifests[Mod]);
        Assert.False(updated.ManifestWritten);
        Assert.Equal(["z.txt"], updated.NoProvider);
    }

    [Fact]
    public async Task AModWhoseManifestNamesItsSource_IsLeftToItsBuild_ThoughItsSourceIsNotThere()
    {
        var built = BuiltSourceMod();

        await Landed(ModFrom("Mod"));

        Assert.Same(built, _folders.Manifests[Mod]);
    }

    [Theory]
    [InlineData("a.esp", "changed since the build")]
    [InlineData("notes.txt", "a file the build did not make")]
    public async Task ASourceModWhoseFolderDiffersFromWhatItsBuildWrote_IsRefused_LeavingItsManifest(string path, string text)
    {
        var built = BuiltSourceMod();
        _folders.WithFile(Mod, path, text);

        var refused = Assert.Single((await Update([SourceMod], [])).Refused);

        Assert.Equal(
            (UpdateManifestRefusal.LeftToItsBuild, "'Mod' was not updated: its build writes its manifest, and its folder differs from what the build wrote."),
            (refused.Refusal, refused.Message));
        Assert.Same(built, _folders.Manifests[Mod]);
    }

    [Fact]
    public async Task ASourceModItsBuildWroteNoManifestFor_IsRefused_WritingNone()
    {
        _folders.WithFile(Mod, "a.esp", "built");

        var refused = Assert.Single((await Update([SourceMod], [])).Refused);

        Assert.Equal(
            (UpdateManifestRefusal.LeftToItsBuild, "'Mod' was not updated: its build writes its manifest, and it has not written one."),
            (refused.Refusal, refused.Message));
        Assert.Empty(_folders.Manifests);
    }

    [Fact]
    public async Task AFileDeletedFromTheModFolder_LeavesTheManifest()
    {
        _folders.WithFile(Mod, "a.txt", "hello").WithFile(Mod, "b.txt", "hello");
        await Update([ModFrom("Mod")], []);

        _folders.Without(Mod, "b.txt");
        await Update([ModFrom("Mod")], []);

        Assert.Equal(["a.txt"], _folders.Manifests[Mod].Files.Select(f => f.Path));
    }
}
