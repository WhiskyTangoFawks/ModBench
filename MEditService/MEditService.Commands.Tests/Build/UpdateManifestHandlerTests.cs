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

    private static ModToUpdate ModFrom(string name, InstallationFile? installationFile = null) =>
        new(name, $"mods/{name}", installationFile, [], IsSourceMod: false, Version: null);

    private Manifest BuiltSourceMod()
    {
        _folders.WithFile(Mod, "a.esp", "built").WithFile(Mod, "z.txt", "edited");
        var built = new Manifest(new ManifestPackage.SourceMod("https://example.com/mod.git", "0123abc"), [
            new ManifestFile("a.esp", new PackageEntry.Held()),
            new ManifestFile("z.txt", new PackageEntry.NotHeld()),
        ]);
        _folders.Manifests[Mod] = built;
        _folders.KeptPackageHashes[Mod] = new Dictionary<string, string> { ["a.esp"] = "built" };
        return built;
    }

    private static ModToUpdate SourceMod => new("Mod", Mod, null, [], IsSourceMod: true, Version: null);

    private InstallationFile Downloaded(string path, params (string Path, string Hash)[] entries)
    {
        _folders.WithBytes(string.Empty, path, Zip(entries));
        return new InstallationFile(path, Page: null, Size: 7, Hash: $"#{path}", [.. entries.Select(e => new HashedEntry(e.Path, e.Hash))]);
    }

    private IEnumerable<ModlistProgress> Progress =>
        _notifications.Notifications.OfType<UpdateManifestProgressNotification>().Select(n => n.Progress);

    private ManifestFile FileOf(string folder, string path) => _folders.Manifests[folder].Files.Single(f => f.Path == path);

    private Task<SelectionResult<string, UpdateManifestRefusal, UpdatedMod>> Update(
        IReadOnlyList<ModToUpdate> mods, string? gesture = null, CancellationToken cancel = default) =>
        Handler.UpdateManifestAsync(mods, new InstanceToUpdate("stat-cache"), gesture, cancel);

    private async Task<UpdatedMod> Landed(params ModToUpdate[] mods)
    {
        var result = await Update(mods);
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
    public async Task AFileWhoseBytesDifferFromItsPackagesCopy_IsNotInThePackage_IsReported_AndNoInstallationFileIsOpened()
    {
        _folders.WithFile(Mod, "meshes/a.nif", "edited");

        var updated = await Landed(ModFrom("Mod", Downloaded("dl/Base.zip", ("Meshes/A.nif", "original"))));

        Assert.IsType<PackageEntry.NotHeld>(FileOf(Mod, "meshes/a.nif").Entry);
        Assert.Equal(["meshes/a.nif"], updated.NotInPackage);
        Assert.Equal(0, _folders.Opens);
    }

    [Fact]
    public async Task AFolderOfItsMetadataAlone_GetsAManifestThatNamesNothing()
    {
        _folders.WithFile(Mod, "meta.ini", "[General]");

        var updated = await Landed(new ModToUpdate("Mod", Mod, null, ["meta.ini"], IsSourceMod: false, Version: null));

        var manifest = _folders.Manifests[Mod];
        Assert.Null(manifest.Package);
        Assert.Empty(manifest.Files);
        Assert.Empty(updated.NotInPackage);
    }

    [Fact]
    public async Task AFileTheInstallationFileHoldsAtItsPath_IsTheShortLine_AndThePackageIsAsTheRequestSaysIt()
    {
        _folders.WithFile(Mod, "meshes/a.nif", "hello");
        var download = Downloaded("dl/Mod.zip", ("meshes/a.nif", "hello")) with { Page = "https://www.nexusmods.com/fallout4/mods/1" };

        await Landed(new ModToUpdate("Mod", Mod, download, [], IsSourceMod: false, Version: null));

        Assert.IsType<PackageEntry.Held>(FileOf(Mod, "meshes/a.nif").Entry);
        Assert.Equal(
            new ManifestPackage.InstallationFile("Mod.zip", 7L, "#dl/Mod.zip", "https://www.nexusmods.com/fallout4/mods/1"),
            _folders.Manifests[Mod].Package);
    }

    [Fact]
    public async Task TheVersionOfAModWithAPackage_IsInItsManifest()
    {
        _folders.WithFile(Mod, "a.txt", "hello");

        await Landed(ModFrom("Mod", Downloaded("dl/Mod.zip", ("a.txt", "hello"))) with { Version = "1.2.3" });

        Assert.Equal("1.2.3", _folders.Manifests[Mod].Version);
    }

    [Fact]
    public async Task TheVersionOfAModWithNoPackage_IsNotInItsManifest()
    {
        _folders.WithFile(Mod, "a.txt", "hello");

        await Landed(ModFrom("Mod") with { Version = "1.2.3" });

        Assert.Null(_folders.Manifests[Mod].Version);
    }

    [Fact]
    public async Task AModWhoseManifestNamesTheGameFolder_IsRefusedWhenTheGameFolderWasNotFound_ItsManifestLeftAsItWas()
    {
        _folders.WithFile(Mod, "a.nif", "a");
        var named = await UpdatedWith(GameFolderHolding(("a.nif", "a")));
        _folders.WithFile("mods/Other", "b.nif", "b");

        var result = await Handler.UpdateManifestAsync([ModFrom("Mod"), ModFrom("Other")], new InstanceToUpdate("stat-cache"));

        var refused = Assert.Single(result.Refused);
        Assert.Equal((UpdateManifestRefusal.GameFolderNotFound, "Mod"), (refused.Refusal, refused.Item));
        Assert.Contains("the game folder was not found", refused.Message);
        Assert.Same(named, _folders.Manifests[Mod]);
        Assert.Equal(["Other"], result.Landed.Select(landed => landed.Item));
    }

    [Fact]
    public async Task AFileTheInstallationFileHoldsUnderAnotherPath_NamesThatPath()
    {
        _folders.WithFile(Mod, "a.nif", "hello");

        await Landed(ModFrom("Mod", Downloaded("dl/Patch.zip", ("Data/a.nif", "hello"))));

        Assert.Equal(ManifestFile.At("a.nif", new FileBytes.InInstallationFile("Patch.zip", "Data/a.nif")).Entry, FileOf(Mod, "a.nif").Entry);
    }

    [Fact]
    public async Task AFileHeldByTwoEntries_NamesTheOneAtItsOwnPath()
    {
        _folders.WithFile(Mod, "b/same.txt", "hello");

        await Landed(ModFrom("Mod", Downloaded("dl/Mod.zip", ("a/same.txt", "hello"), ("b/same.txt", "hello"))));

        Assert.IsType<PackageEntry.Held>(FileOf(Mod, "b/same.txt").Entry);
    }

    [Fact]
    public async Task AFilePathedInADifferentCaseThanItsEntry_IsStillTheShortLine()
    {
        _folders.WithFile(Mod, "Textures/A.dds", "hello");

        await Landed(ModFrom("Mod", Downloaded("dl/Mod.zip", ("textures/a.dds", "hello"))));

        Assert.IsType<PackageEntry.Held>(FileOf(Mod, "Textures/A.dds").Entry);
    }

    [Fact]
    public async Task AnUpdatedMod_KeepsInItsStatCache_EachFilesHash_AsTheHashItsPackageFixes()
    {
        _folders.WithFile(Mod, "a.txt", "hello");

        await Landed(ModFrom("Mod", Downloaded("dl/Mod.zip", ("a.txt", "hello"))));

        Assert.Equal(new Dictionary<string, string> { ["a.txt"] = "hello" }, _folders.KeptPackageHashes[Mod]);
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
    public async Task AFileNothingHolds_WithNoCopyAtItsPath_IsNotInThePackage_AndIsReported()
    {
        _folders.WithFile(Mod, "a.txt", "hellO").WithFile(Mod, "b.txt", "hello");

        var updated = await Landed(ModFrom("Mod", Downloaded("dl/Mod.zip", ("other/a.txt", "hello"), ("b.txt", "hello"))));

        Assert.IsType<PackageEntry.NotHeld>(FileOf(Mod, "a.txt").Entry);
        Assert.Equal(["a.txt"], updated.NotInPackage);
    }

    [Fact]
    public async Task AModWithAnInstallationFileMissing_IsRefusedNamingTheModAndFile_AndTheOthersLand()
    {
        _folders.WithFile("mods/Lost", "a.txt", "hello").WithFile("mods/Found", "a.txt", "hello");
        var lost = new InstallationFile("dl/Lost.zip", null, 7, "#lost", [new HashedEntry("a.txt", "hello")]);

        var result = await Update([ModFrom("Lost", lost), ModFrom("Found", Downloaded("dl/Found.zip", ("a.txt", "hello")))]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(("Lost", UpdateManifestRefusal.InstallationFileMissing), (refused.Item, refused.Refusal));
        Assert.Equal("was not updated: 'Lost.zip' not in the downloads folder.", refused.Message);
        Assert.False(_folders.Manifests.ContainsKey("mods/Lost"));
        Assert.Equal(["Found"], result.Landed.Select(l => l.Item));
    }

    [Fact]
    public async Task AModWhoseFolderIsGone_IsRefused()
    {
        var refused = Assert.Single((await Update([ModFrom("Gone")])).Refused);

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

        var result = await Update([ModFrom("Held"), ModFrom("Fine")]);

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

        var result = await Update([ModFrom("Locked"), ModFrom("Fine")]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(("Locked", UpdateManifestRefusal.NotWritten), (refused.Item, refused.Refusal));
        Assert.Equal(["Fine"], result.Landed.Select(l => l.Item));
    }

    [Fact]
    public async Task AFileTheRepositoryCommitsItself_HasNoLineAndIsNotReported()
    {
        _folders.WithFile(Mod, "meta.ini", "hello").WithFile(Mod, "a.txt", "hello");

        var updated = await Landed(ModFrom("Mod") with { MetadataFiles = ["meta.ini"] });

        Assert.Equal(["a.txt"], _folders.Manifests[Mod].Files.Select(f => f.Path));
        Assert.Equal(["a.txt"], updated.NotInPackage);
    }

    [Fact]
    public async Task AModNamedTwice_IsUpdatedOnce()
    {
        _folders.WithFile(Mod, "a.txt", "hello");

        var result = await Update([ModFrom("Mod"), ModFrom("MOD")]);

        Assert.Single(result.Landed);
    }

    [Fact]
    public async Task ProgressNamesItsGestureAndEachModInFlight_ThenGoesIdle()
    {
        _folders.WithFile("mods/A", "a.txt", "hello").WithFile("mods/B", "a.txt", "hello");

        await Update([ModFrom("A"), ModFrom("B")], "g");

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

        var result = await Update([ModFrom("A"), ModFrom("B")], cancel: cancel.Token);

        Assert.Equal(["A"], result.Landed.Select(landed => landed.Item));
        Assert.Empty(result.Refused);
        Assert.Equal(new ModlistProgress(null, null, 0, 0), Progress.Last());
    }

    [Fact]
    public async Task ASourceModAsItsBuildWroteIt_Lands_LeavingItsManifest_AndReportsEachFileNotInItsPackage()
    {
        var built = BuiltSourceMod();

        var updated = await Landed(SourceMod);

        Assert.Same(built, _folders.Manifests[Mod]);
        Assert.False(updated.ManifestWritten);
        Assert.Equal(["z.txt"], updated.NotInPackage);
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

        var refused = Assert.Single((await Update([SourceMod])).Refused);

        Assert.Equal(
            (UpdateManifestRefusal.LeftToItsBuild, "was not updated: its build writes its manifest, and its folder differs from what the build wrote."),
            (refused.Refusal, refused.Message));
        Assert.Same(built, _folders.Manifests[Mod]);
    }

    [Fact]
    public async Task ASourceModItsBuildWroteNoManifestFor_IsRefused_WritingNone()
    {
        _folders.WithFile(Mod, "a.esp", "built");

        var refused = Assert.Single((await Update([SourceMod])).Refused);

        Assert.Equal(
            (UpdateManifestRefusal.LeftToItsBuild, "was not updated: its build writes its manifest, and it has not written one."),
            (refused.Refusal, refused.Message));
        Assert.Empty(_folders.Manifests);
    }

    [Fact]
    public async Task AFileDeletedFromTheModFolder_LeavesTheManifest()
    {
        _folders.WithFile(Mod, "a.txt", "hello").WithFile(Mod, "b.txt", "hello");
        await Update([ModFrom("Mod")]);

        _folders.Without(Mod, "b.txt");
        await Update([ModFrom("Mod")]);

        Assert.Equal(["a.txt"], _folders.Manifests[Mod].Files.Select(f => f.Path));
    }

    private static GameFolder GameFolderHolding(params (string Path, string Text)[] files) =>
        new("Fallout 4", "data", [.. files.Select(file => new GameFile(file.Path, file.Text))]);

    private async Task<Manifest> UpdatedWith(GameFolder? gameFolder, ModToUpdate? mod = null)
    {
        var result = await Handler.UpdateManifestAsync([mod ?? ModFrom("Mod")], new InstanceToUpdate("stat-cache", gameFolder));
        Assert.Empty(result.Refused);
        return _folders.Manifests[Mod];
    }

    [Fact]
    public async Task AModWithNoInstallationFile_WhoseFilesTheGameFolderHoldsWithTheirBytes_NamesTheGameFolderAsItsPackage()
    {
        _folders.WithFile(Mod, "meshes/a.nif", "a").WithFile(Mod, "b.dds", "b");

        var manifest = await UpdatedWith(GameFolderHolding(("Meshes/A.nif", "a"), ("b.dds", "b")));

        Assert.Equal(
            new ManifestPackage.GameFolder("Fallout 4", FileHash.OfFilesTaken([new HashedFile("meshes/a.nif", "a"), new HashedFile("b.dds", "b")])),
            manifest.Package);
        Assert.All(manifest.Files, file => Assert.IsType<PackageEntry.Held>(file.Entry));
    }

    [Fact]
    public async Task AGameFolderModsManifest_DoesNotChange_WhenTheGameFolderGainsOrChangesAFileTheModDoesNotTake()
    {
        _folders.WithFile(Mod, "a.nif", "a");
        await UpdatedWith(GameFolderHolding(("a.nif", "a")));

        var result = await Handler.UpdateManifestAsync(
            [ModFrom("Mod")], new InstanceToUpdate("stat-cache", GameFolderHolding(("a.nif", "a"), ("other.nif", "new"), ("more.nif", "x"))));

        Assert.False(result.Landed.Single().Outcome.ManifestWritten);
    }

    [Fact]
    public async Task AGameFolderModsManifest_Changes_WhenAFileItTakesChanges()
    {
        _folders.WithFile(Mod, "a.nif", "a");
        var before = (await UpdatedWith(GameFolderHolding(("a.nif", "a")))).Package;
        _folders.WithFile(Mod, "a.nif", "a2");

        var after = (await UpdatedWith(GameFolderHolding(("a.nif", "a2")))).Package;

        Assert.NotEqual(before, after);
    }

    [Fact]
    public async Task AModWithAFileTheGameFolderHoldsWithOtherBytes_OrNotAtAll_HasNoPackage_AndItsFilesAreNotInIt()
    {
        _folders.WithFile(Mod, "a.nif", "a").WithFile(Mod, "mine.nif", "mine").WithFile(Mod, "c.nif", "edited");

        var manifest = await UpdatedWith(GameFolderHolding(("a.nif", "a"), ("c.nif", "c")));

        Assert.Null(manifest.Package);
        Assert.All(manifest.Files, file => Assert.IsType<PackageEntry.NotHeld>(file.Entry));
    }

    [Fact]
    public async Task AModWithNoFiles_IsNotFromTheGameFolder()
    {
        _folders.WithFile(Mod, "meta.ini", "[General]");

        var manifest = await UpdatedWith(GameFolderHolding(("a.nif", "a")), new ModToUpdate("Mod", Mod, null, ["meta.ini"], IsSourceMod: false, Version: null));

        Assert.Null(manifest.Package);
    }

    [Fact]
    public async Task AModWithAnInstallationFile_NamesItAsItsPackage_WhateverTheGameFolderHolds()
    {
        _folders.WithFile(Mod, "a.nif", "a");
        var download = Downloaded("dl/Mod.zip", ("a.nif", "a"));

        var manifest = await UpdatedWith(GameFolderHolding(("a.nif", "a")), ModFrom("Mod", download));

        Assert.IsType<ManifestPackage.InstallationFile>(manifest.Package);
    }
}
