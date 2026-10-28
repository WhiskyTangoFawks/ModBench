using System.Text;
using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.Commands.Tests.Build;

public sealed class BuildModHandlerTests : IDisposable
{
    private const string ModName = "Mod";
    private const string ExclusionMark = ".excluded";
    private const string MetaIni = "meta.ini";
    private const string Remote = "https://example.com/mod.git";

    private readonly InstanceToBuild _noArchives;

    private readonly ScratchDirectory _root = new("medit-build-handler-");
    private readonly LoadOrderHolder _holder = new();

    public BuildModHandlerTests() => _noArchives = new(ExclusionMark, Archives: null, StatCache);

    public void Dispose() => _root.Dispose();

    private string StatCache => Path.Combine(_root, "stat-cache");

    private string ModFolder => Path.Combine(_root, "mods", ModName);

    private const string SourceFolderName = "Mod Source";

    private string SourceFolder => Path.Combine(_root, "source", SourceFolderName);

    [Fact]
    public async Task Build_LeavesAFileItDidNotMake_AndNamesEachFileItReplacedThatHeldOtherBytes()
    {
        WriteSource("{\"output\": \"Mod\"}", ("textures/a.dds", "a"), ("meshes/c.nif", "c"));
        WriteInFolder("textures/a.dds", "changed in the folder");
        WriteInFolder("meshes/c.nif", "c");
        WriteInFolder("notes.txt", "mine");

        var built = await Landed();

        Assert.Equal([("meshes/c.nif", "c"), ("notes.txt", "mine"), ("textures/a.dds", "a")], FilesIn(ModFolder));
        Assert.Equal(["textures/a.dds"], built.Overwritten);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ABuiltMod_NamesItsRepositoryByItsSourceFoldersName_AsThePackage_SubmoduleOrNotAsTheRequestSays_AndHoldsEachFileItMade(bool isSubmodule)
    {
        WriteSource("{\"output\": \"Mod\"}", ("meshes/c.nif", "added c"));
        WriteInFolder(MetaIni, "[General]");
        WriteInFolder("notes.txt", "mine");

        await Landed(_noArchives, isSubmodule);

        var manifest = ManifestWritten().Require();
        Assert.Equal(new ManifestPackage.SourceRepository(SourceFolderName, isSubmodule), manifest.Package);
        Assert.Equal([new ManifestFile("meshes/c.nif", new PackageEntry.Held())], manifest.Files);
    }

    [Fact]
    public async Task ABuild_WritesItsManifestInItsRepository_KeepingWhatItBuildsFrom_AndNoneInTheModFolder()
    {
        WriteSource("{\"output\": \"Mod\", \"exclude\": [\"meshes/c.nif\"], \"archives\": {\"Mod - Main.ba2\": [\"meshes/d.nif\"]}}",
            ("meshes/c.nif", "c"), ("meshes/d.nif", "d"));

        await Landed();

        Assert.Equal(["Mod.manifest.json"], Directory.GetFiles(SourceFolder).Select(Path.GetFileName));
        var manifest = ManifestWritten().Require();
        Assert.Equal("Mod", manifest.Output);
        Assert.Equal(["meshes/c.nif"], manifest.Exclude);
        Assert.Equal(["Mod - Main.ba2"], manifest.Archives.Select(archive => archive.Path));
        Assert.Equal(["meshes/c.nif.excluded"], manifest.Files.Select(file => file.Path));
        Assert.Null(new ModFolderRepository(TimeProvider.System).ReadManifest(ModFolder));
    }

    [Theory]
    [InlineData("assets/meshes/c.nif", "changed", true)]
    [InlineData("assets/meshes/c.nif", "c", false)]
    public async Task ABuildFromASharedSource_SaysWhenItsSourceHoldsChangesNoCommitHolds(string written, string text, bool uncommitted)
    {
        WriteSource("{\"output\": \"Mod\"}", ("meshes/c.nif", "c"));
        Shared();
        Write(SourceFolder, written, Encoding.UTF8.GetBytes(text));

        Assert.Equal(uncommitted, (await Landed()).Uncommitted);
    }

    [Theory]
    [InlineData("refs/remotes/origin/main", false)]
    [InlineData("refs/heads/kept", true)]
    public async Task ABuildAtACommitItsRemoteDoesNotHold_SaysSo(string holding, bool unpushed)
    {
        WriteSource("{\"output\": \"Mod\"}", ("meshes/c.nif", "c"));
        Shared();
        GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "update-ref", holding, "HEAD");

        Assert.Equal(unpushed, (await Landed()).Unpushed);
    }

    [PosixFact]
    public async Task TwoPluginSourcesWhoseNamesDifferInCaseAlone_AreEachRefusedByName_AndTheRestOfTheModBuilds()
    {
        WriteSource("{\"output\": \"Mod\"}", ("meshes/c.nif", "c"));
        Directory.CreateDirectory(Path.Combine(SourceFolder, "plugin-source", "Fixture.esp"));
        Directory.CreateDirectory(Path.Combine(SourceFolder, "plugin-source", "fixture.esp"));

        var built = await Landed();

        Assert.Equal(
            [
                ("Fixture.esp", CompileRefusal.TwinPluginSources,
                    "Fixture.esp cannot be compiled: the plugin sources 'Fixture.esp' and 'fixture.esp' differ only in case, and one mod folder cannot hold them on Windows."),
                ("fixture.esp", CompileRefusal.TwinPluginSources,
                    "fixture.esp cannot be compiled: the plugin sources 'Fixture.esp' and 'fixture.esp' differ only in case, and one mod folder cannot hold them on Windows."),
            ],
            built.Refused.Select(refused => (refused.Item.Name, refused.Refusal, refused.Message)));
        Assert.Equal([("meshes/c.nif", "c")], FilesIn(ModFolder));
    }

    [Fact]
    public async Task AJustBuiltMod_DiffersFromItsManifestOnlyByTheFilesTheBuildDidNotMake()
    {
        WriteSource("{\"output\": \"Mod\"}", ("meshes/c.nif", "added c"));
        WriteInFolder(MetaIni, "[General]");
        WriteInFolder("notes.txt", "mine");
        Shared();

        await Landed(_noArchives, isSubmodule: true);

        Assert.Equal(new ModStatus(ModName, NoManifest: false, [], ["notes.txt"], [], [], []), Status());
    }

    [Fact]
    public async Task AnArchiveTheBuildDidNotPack_Differs_ThoughItsSourceProvidesIt()
    {
        WriteSource("{\"output\": \"Mod\", \"archives\": {\"Mod - Main.ba2\": [\"meshes/c.nif\"]}}", ("meshes/c.nif", "c"));
        WriteInFolder("Mod - Main.ba2", "packed by an earlier build");
        Shared();

        Assert.Single((await Landed()).ArchivesRefused);

        Assert.Equal(["Mod - Main.ba2"], Status().Differing);
    }

    [Fact]
    public async Task Build_WritesAnExcludedFile_AndEachFileOfAnExcludedFolder_UnderTheExclusionMarkHanded()
    {
        WriteSource("{\"output\": \"Mod\", \"exclude\": [\"Textures/A.dds\", \"meshes\"]}",
            ("textures/a.dds", "a"), ("textures/b.dds", "b"), ("meshes/deep/c.nif", "c"));

        await Landed();

        Assert.Equal([("meshes.excluded/deep/c.nif", "c"), ("textures/a.dds.excluded", "a"), ("textures/b.dds", "b")], FilesIn(ModFolder));
    }

    [Fact]
    public async Task AModWhoseRepositoryHoldsNoManifest_IsRefused_WritingNothing()
    {
        Directory.CreateDirectory(SourceFolder);

        var refused = Assert.Single((await Build(_noArchives)).Refused);

        Assert.Equal(BuildRefusal.SourceUnreadable, refused.Refusal);
        Assert.Equal($"was not built: '{SourceFolder}' holds no manifest.", refused.Message);
        Assert.False(Directory.Exists(ModFolder));
    }

    [Theory]
    [InlineData("{\"output\": \"Other\"}", BuildRefusal.OutputNotThisMod,
        "its manifest names the output folder 'Other', not its folder 'Mod'.")]
    [InlineData("{\"output\": \"Mod\", \"archives\": {\"Mod - Main.ba2\": [\"meshes/c.nif\", \"a.txt\"]}}", BuildRefusal.ArchiveFileNotAnAsset,
        "'Mod - Main.ba2' takes 'a.txt', which is not an asset of its source.")]
    [InlineData("{\"output\": \"Mod\", \"steps\": [{\"task\": \"Zip\"}], \"tools\": [{\"task\": \"Zip\", \"page\": \"https://example.com/zip\"}]}",
        BuildRefusal.NoTaskForTool, "this machine has no task for its tool 'Zip' (https://example.com/zip).")]
    [InlineData("{\"output\": \"Mod\", \"steps\": [{\"task\": \"Zip\"}, {\"task\": \"Pack\"}], \"tools\": [{\"task\": \"Pack\", \"page\": \"https://example.com/pack\"}]}",
        BuildRefusal.NoTaskForTool, "this machine has no task for its tools 'Zip' and 'Pack' (https://example.com/pack).")]
    public async Task ABuildThatCannotMakeTheFolderItsManifestSays_RefusesTheMod_WritingNothing(
        string configuration, BuildRefusal refusal, string why)
    {
        WriteSource(configuration, ("meshes/c.nif", "c"));

        var result = await Build(_noArchives);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(refusal, refused.Refusal);
        Assert.StartsWith("was not built: ", refused.Message, StringComparison.Ordinal);
        Assert.EndsWith(why, refused.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(ModFolder));
    }

    [Fact]
    public async Task ABuildWithSteps_MakesTheFolder_AnswersItsStepsAndEachFileItMade_AndLeavesItsManifestUntilTheyRan()
    {
        WriteSourceText(WithAStep, ("meshes/c.nif", "c"), ("textures/a.dds", "a"));

        var built = await Landed(WithItsTask);

        Assert.Equal([("Optimise textures", "textures")], built.Steps.Select(step => (step.Task, string.Join('|', step.Args))));
        Assert.Equal(["meshes/c.nif"], built.Made);
        Assert.Equal([("meshes/c.nif", "c"), ("textures/a.dds", "a")], FilesIn(ModFolder));
        Assert.Equal([new ManifestFile("textures/a.dds", new PackageEntry.MadeByStep())], ManifestWritten().Require().Files);
    }

    [Fact]
    public async Task OnceItsStepsRan_ItsBuildWritesItsManifest_EachFileItMadeThatTheFolderHolds_AndEachFileAStepMakes_AndNothingDiffers()
    {
        WriteSourceText(WithAStep, ("meshes/c.nif", "c"), ("meshes/d.nif", "d"));
        var built = await Landed(WithItsTask);
        File.Delete(Path.Combine(ModFolder, "meshes", "d.nif"));
        WriteInFolder("textures/a.dds", "optimised");

        Assert.Empty((await Build(WithItsTask, made: built.Made)).Refused);

        Assert.Equal(
            [new ManifestFile("meshes/c.nif", new PackageEntry.Held()), new ManifestFile("textures/a.dds", new PackageEntry.MadeByStep())],
            ManifestWritten().Require().Files);
        Assert.Equal([("meshes/c.nif", "c"), ("textures/a.dds", "optimised")], FilesIn(ModFolder));
        var status = Status();
        Assert.Equal((0, 0, 0), (status.Differing.Count, status.NamedByNoLine.Count, status.Gone.Count));
    }

    [PosixFact]
    public async Task AFileThatCannotBeReadAfterTheFirstWrite_LandsTheBuildWithThatFailure_NamingWhatItOverwroteSoFar()
    {
        WriteSource("{\"output\": \"Mod\"}", ("a.txt", "a"), ("z.txt", "z"));
        WriteInFolder("a.txt", "changed in the folder");
        var held = Path.Combine(SourceFolder, "assets", "z.txt");
        FileModes.Set(held, "000");
        ModBuilt built;
        try
        {
            built = await Landed();
        }
        finally
        {
            FileModes.Set(held, "600");
        }

        Assert.Equal(["a.txt"], built.Overwritten);
        Assert.StartsWith("The build stopped before compiling, as a file could not be read or written: ", built.Failure, StringComparison.Ordinal);
        Assert.Contains("z.txt", built.Failure, StringComparison.Ordinal);
        Assert.Empty(ManifestWritten().Require().Files);
    }

    [Fact]
    public async Task Build_PacksEachArchiveFromItsAssets_TexturesAsTheTexturesVariant_LeavingNoneOfThemLoose()
    {
        WriteSource(
            "{\"output\": \"Mod\", \"archives\": {\"Mod - Main.ba2\": [\"meshes/c.nif\"], \"Mod - Textures.ba2\": [\"textures/a.dds\"]}}",
            ("meshes/c.nif", "c"), ("readme.txt", "loose"));
        WriteAsset("textures/a.dds", Dds.Dxt1(8, 8, 1).File);

        var built = await Landed(new InstanceToBuild(ExclusionMark, new ArchiveVariants(
            new Ba2Variant(1, Ba2Contents.General, Compressed: false), new Ba2Variant(1, Ba2Contents.Textures, Compressed: false)), StatCache));

        Assert.Empty(built.ArchivesRefused);
        Assert.Equal(["Mod - Main.ba2", "Mod - Textures.ba2", "readme.txt"], FilesIn(ModFolder).Select(file => file.Path));
        Assert.Equal("GNRL", Encoding.ASCII.GetString(File.ReadAllBytes(Path.Combine(ModFolder, "Mod - Main.ba2")), 8, 4));
        Assert.Equal("DX10", Encoding.ASCII.GetString(File.ReadAllBytes(Path.Combine(ModFolder, "Mod - Textures.ba2")), 8, 4));
    }

    [Fact]
    public async Task AGameWhoseTableNamesNoArchiveVariant_RefusesEachArchive_AndBuildsTheRest()
    {
        WriteSource("{\"output\": \"Mod\", \"archives\": {\"Mod - Main.ba2\": [\"meshes/c.nif\"]}}", ("meshes/c.nif", "c"), ("readme.txt", "loose"));

        var built = await Landed();

        var refused = Assert.Single(built.ArchivesRefused);
        Assert.Equal(("Mod - Main.ba2", ArchiveRefusal.VariantNotWritten), (refused.Item, refused.Refusal));
        Assert.Equal([("readme.txt", "loose")], FilesIn(ModFolder));
    }

    [Fact]
    public async Task APluginChangedOutsideModbench_IsNamedOverwritten_WithEachOfItsStringsFilesThatDiffered()
    {
        await InitializedWithALocalizedPlugin();
        var stringsFiles = Directory.GetFiles(Path.Combine(ModFolder, "Strings")).Order(StringComparer.Ordinal).ToList();
        File.AppendAllText(Path.Combine(ModFolder, "Fixture.esp"), "changed outside Modbench");
        File.WriteAllText(stringsFiles[0], "changed outside Modbench");

        var built = Assert.Single((await TestEditService.BuildModHandler(_holder)
            .BuildAsync([new ModToBuild(ModName, SourceFolder, ModFolder, [MetaIni], null, IsSubmodule: false)], _noArchives)).Value().Applied);

        Assert.Equal(["Fixture.esp", $"Strings/{Path.GetFileName(stringsFiles[0])}"], built.Overwritten);
    }

    [Fact]
    public async Task ACompiledPlugin_AndItsStrings_AreHeldByItsSource_AndDoNotDiffer()
    {
        await InitializedWithALocalizedPlugin();
        GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "remote", "add", "origin", Remote);

        Assert.Single((await TestEditService.BuildModHandler(_holder)
            .BuildAsync([new ModToBuild(ModName, SourceFolder, ModFolder, [MetaIni], null, IsSubmodule: true)], _noArchives)).Value().Applied);

        var stringsFiles = Directory.GetFiles(Path.Combine(ModFolder, "Strings")).Select(file => $"Strings/{Path.GetFileName(file)}");
        var manifest = ManifestWritten().Require();
        Assert.Equal(new ManifestPackage.SourceRepository(SourceFolderName, IsSubmodule: true), manifest.Package);
        Assert.Equal(
            [.. new[] { "Fixture.esp" }.Concat(stringsFiles).Order(StringComparer.Ordinal).Select(path => new ManifestFile(path, new PackageEntry.Held()))],
            manifest.Files);
        Assert.Empty(Status().Differing);
    }

    [Fact]
    public async Task AFreshClone_WithNoPluginFile_BuildsEachPluginFromItsSource()
    {
        await InitializedWithALocalizedPlugin();
        Directory.Delete(ModFolder, recursive: true);
        WriteInFolder(MetaIni, "[General]");
        _holder.Apply(SnapshotPlugins.Snapshot(Path.Combine(_root, "Data"), _root, GameRelease.Fallout4, []));

        var built = Assert.Single((await TestEditService.BuildModHandler(_holder)
            .BuildAsync([new ModToBuild(ModName, SourceFolder, ModFolder, [MetaIni], null, IsSubmodule: false)], _noArchives)).Value().Applied);

        Assert.Equal(["Fixture.esp"], built.Compiled.Select(plugin => plugin.Name));
        Assert.True(File.Exists(Path.Combine(ModFolder, "Fixture.esp")));
    }

    [Fact]
    public async Task ASourceModWithNoRemote_WritesItsVersionOnItsPackagesLine()
    {
        WriteSource("{\"output\": \"Mod\"}");
        WriteInFolder(MetaIni, "[General]");

        _holder.Apply(SnapshotPlugins.Snapshot(_root, _root, GameRelease.Fallout4, []));
        var built = (await TestEditService.BuildModHandler(_holder)
            .BuildAsync([new ModToBuild(ModName, SourceFolder, ModFolder, [MetaIni], "1.2.3", IsSubmodule: false)], _noArchives)).Value();

        Assert.Empty(built.Refused);

        Assert.Equal("1.2.3", ManifestWritten().Require().Version);
    }

    [Fact]
    public async Task AFileTheManifestTakesFromAnInstallationFile_ReplacesTheSourcesPlaceholder_AndItsLineKeepsNamingItsPackage()
    {
        WriteSourceText(DownloadedZip.TakingFromAPack, ("textures/a.dds", "placeholder"));

        await Landed(_noArchives, installationFiles: [Pack(("textures/a.dds", "from the pack"), ("Data/c.nif", "moved"))]);

        Assert.Equal([("meshes/c.nif", "moved"), ("textures/a.dds", "from the pack")], FilesIn(ModFolder));
        var manifest = ManifestWritten().Require();
        Assert.Equal(
            [new ManifestPackage.SourceRepository(SourceFolderName, IsSubmodule: false), new ManifestPackage.InstallationFile(DownloadedZip.PackName, 1, DownloadedZip.PackHash)],
            manifest.Packages);
        Assert.Equal(
            [new ManifestFile("meshes/c.nif", ManifestFile.At("meshes/c.nif", new FileBytes.InInstallationFile(DownloadedZip.PackName, "Data/c.nif")).Entry, DownloadedZip.PackName),
                new ManifestFile("textures/a.dds", new PackageEntry.Held(), DownloadedZip.PackName)],
            manifest.Files.OrderBy(file => file.Path, StringComparer.Ordinal));
        Assert.Empty(Status().Differing);
        Assert.Empty(Status().Gone);
    }

    [Fact]
    public async Task AnArchive_PacksAFileTakenFromAnInstallationFile_LeavingNoLooseCopy_ThoughItsLineStays_AndTheModIsNotGone()
    {
        WriteSourceText(DownloadedZip.TakingFromAPack.Replace("\"files\"", "\"archives\": {\"Mod - Main.ba2\": [\"meshes/c.nif\"]}, \"files\""));
        var variants = new ArchiveVariants(new Ba2Variant(1, Ba2Contents.General, Compressed: false), new Ba2Variant(1, Ba2Contents.Textures, Compressed: false));

        var built = await Landed(new InstanceToBuild(ExclusionMark, variants, StatCache), installationFiles: [Pack(("textures/a.dds", "a"), ("Data/c.nif", "moved"))]);

        Assert.Empty(built.ArchivesRefused);
        Assert.Equal(["Mod - Main.ba2", "textures/a.dds"], FilesIn(ModFolder).Select(file => file.Path));
        Assert.Contains("meshes/c.nif", ManifestWritten().Require().Files.Select(file => file.Path));
        Assert.Empty(Status().Gone);
    }

    [Fact]
    public async Task ATakenFileTheExclusionMarkRenames_IsRecordedUnderItsFolderName_WhereItsPackageHoldsItUnmarked()
    {
        WriteSourceText(DownloadedZip.TakingFromAPack.Replace("\"files\"", "\"exclude\": [\"textures/a.dds\"], \"files\""));

        await Landed(_noArchives, installationFiles: [Pack(("textures/a.dds", "a"), ("Data/c.nif", "moved"))]);

        Assert.Equal(["meshes/c.nif", "textures/a.dds.excluded"], FilesIn(ModFolder).Select(file => file.Path));
        Assert.Equal(
            ManifestFile.At("textures/a.dds.excluded", new FileBytes.InInstallationFile(DownloadedZip.PackName, "textures/a.dds")) with { Package = DownloadedZip.PackName },
            ManifestWritten().Require().Files.Single(file => file.Path.StartsWith("textures", StringComparison.Ordinal)));
        Assert.Empty(Status().Gone);
        Assert.Empty(Status().Differing);
    }

    [Fact]
    public async Task AnInstallationFileTheRequestDidNotHand_RefusesTheMod_NamingItForTheRequestToFind_AndWritesNothing()
    {
        WriteSourceText(DownloadedZip.TakingFromAPack, ("textures/a.dds", "placeholder"));

        var refused = Assert.Single((await Build(_noArchives)).Refused);

        Assert.Equal(BuildRefusal.PackageLacking, refused.Refusal);
        Assert.Equal(DownloadedZip.PackName, Assert.Single(refused.InstallationFilesNotFound).Name);
        Assert.Contains("installation file 'Pack.zip' is missing", refused.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(ModFolder));
    }

    [Fact]
    public async Task AFileTheManifestTakesFromTheGameFolder_ComesFromThePlaceThatHoldsItsBytes_AndItsLineKeepsNamingTheGameFolder()
    {
        var edited = GameFolderHolding("edited", ("textures/a.dds", "edited"));
        var vanilla = GameFolderHolding("steam", ("textures/a.dds", "from the game"));
        var game = edited with { Elsewhere = [new GameFolderPlace(vanilla.DataFolder, vanilla.Files)] };
        WriteSourceText(TakingFromTheGame(vanilla));

        var built = await Landed(_noArchives with { GameFolder = game });

        Assert.Empty(built.Overwritten);
        Assert.Equal([("textures/a.dds", "from the game")], FilesIn(ModFolder));
        var manifest = ManifestWritten().Require();
        Assert.Equal(["Fallout 4"], manifest.Packages.OfType<ManifestPackage.GameFolder>().Select(package => package.Name));
        Assert.Equal([new ManifestFile("textures/a.dds", new PackageEntry.Held(), "Fallout 4")], manifest.Files);
    }

    [Fact]
    public async Task AGameFileTheRequestDidNotHand_RefusesTheMod_NamingItForTheRequestToFind_AndWritesNothing()
    {
        WriteSourceText(TakingFromTheGame(GameFolderHolding("steam", ("textures/a.dds", "from the game"))));

        var refused = Assert.Single((await Build(_noArchives)).Refused);

        Assert.Equal(BuildRefusal.PackageLacking, refused.Refusal);
        Assert.Equal(["textures/a.dds"], refused.GameFilesNotFound);
        Assert.False(Directory.Exists(ModFolder));
    }

    [Fact]
    public async Task AGameFileWithOtherBytesInEveryPlace_RefusesTheMod_AndIsNotAskedForAgain()
    {
        var pinned = GameFolderHolding("steam", ("textures/a.dds", "from the game"));
        WriteSourceText(TakingFromTheGame(pinned));

        var refused = Assert.Single((await Build(_noArchives with { GameFolder = GameFolderHolding("edited", ("textures/a.dds", "edited")) })).Refused);

        Assert.Equal(BuildRefusal.PackageLacking, refused.Refusal);
        Assert.Empty(refused.GameFilesNotFound);
        Assert.False(Directory.Exists(ModFolder));
    }

    [Fact]
    public async Task AnInstallationFileWithOtherBytes_RefusesTheMod_AndIsNotAskedForAgain()
    {
        WriteSourceText(DownloadedZip.TakingFromAPack, ("textures/a.dds", "placeholder"));

        var refused = Assert.Single((await Build(_noArchives, installationFiles: [Pack(("textures/a.dds", "a"), ("Data/c.nif", "c")) with { Hash = "OTHER" }])).Refused);

        Assert.Equal((BuildRefusal.PackageLacking, "was not built: installation file 'Pack.zip' has other bytes."), (refused.Refusal, refused.Message));
        Assert.Empty(refused.InstallationFilesNotFound);
    }

    [Fact]
    public async Task AnInstallationFileWithoutAnEntryALineTakes_RefusesTheMod_NamingTheEntry()
    {
        WriteSourceText(DownloadedZip.TakingFromAPack, ("textures/a.dds", "placeholder"));

        var refused = Assert.Single((await Build(_noArchives, installationFiles: [Pack(("textures/a.dds", "a"))])).Refused);

        Assert.Equal("was not built: installation file 'Pack.zip' holds no 'Data/c.nif'.", refused.Message);
    }

    [Fact]
    public async Task AnInstallationFileTheRequestCouldNotRead_RefusesTheMod_NamingWhy_AndIsNotAskedForAgain()
    {
        WriteSourceText(DownloadedZip.TakingFromAPack, ("textures/a.dds", "placeholder"));
        var unreadable = new Dictionary<string, string> { [DownloadedZip.PackName] = "EACCES" };

        var refused = Assert.Single((await Build(_noArchives, unreadableInstallationFiles: unreadable)).Refused);

        Assert.Equal("was not built: installation file 'Pack.zip' could not be read: EACCES.", refused.Message);
        Assert.Empty(refused.InstallationFilesNotFound);
    }

    private async Task InitializedWithALocalizedPlugin()
    {
        var plugin = Path.Combine(Directory.CreateDirectory(ModFolder).FullName, "Fixture.esp");
        var written = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        written.Doors.AddNew("FixtureDoor").Name = new TranslatedString(Language.English, "The Big Door");
        written.UsingLocalization = true;
        written.WriteToBinary(plugin);
        var provider = new PluginProvider.FromMod(ModName, ModFolder, SourceFolder);
        _holder.Apply(SnapshotPlugins.Snapshot(Directory.CreateDirectory(Path.Combine(_root, "Data")).FullName, _root, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", plugin, ModName, 0, Enabled: true, Winning: true, NamedProvider: provider)]));
        Assert.Single((await TestEditService.DecompileAndCommitModHandler(_holder).DecompileAndCommitAsync([new ModToDecompileAndCommit(ModName, SourceFolder, [])])).Value().Applied);
    }

    private async Task<ModBuilt> Landed() => await Landed(_noArchives);

    private async Task<ModBuilt> Landed(InstanceToBuild instance, bool isSubmodule = false, IReadOnlyList<InstallationFile>? installationFiles = null)
    {
        var result = await Build(instance, isSubmodule, installationFiles: installationFiles);
        Assert.Empty(result.Refused);
        return Assert.Single(result.Applied);
    }

    private async Task<BuildResult> Build(
        InstanceToBuild instance, bool isSubmodule = false, IReadOnlyList<string>? made = null, IReadOnlyList<InstallationFile>? installationFiles = null,
        IReadOnlyDictionary<string, string>? unreadableInstallationFiles = null)
    {
        _holder.Apply(SnapshotPlugins.Snapshot(_root, _root, GameRelease.Fallout4, []));
        return (await TestEditService.BuildModHandler(_holder).BuildAsync(
            [new ModToBuild(ModName, SourceFolder, ModFolder, [MetaIni], null, isSubmodule, made) { InstallationFiles = installationFiles ?? [], UnreadableInstallationFiles = unreadableInstallationFiles }], instance)).Value();
    }

    private GameFolder GameFolderHolding(string place, params (string Path, string Text)[] files)
    {
        var data = Directory.CreateDirectory(Path.Combine(_root, "game", place, "Data")).FullName;
        foreach (var (path, text) in files) Write(data, path, Encoding.UTF8.GetBytes(text));
        var hashes = new ModFolderRepository(TimeProvider.System).Files(data, new HashSet<string>(), null).Files;
        return new GameFolder("Fallout 4", data, [.. hashes.Select(file => new GameFile(file.Path, file.Hash))]);
    }

    private static string TakingFromTheGame(GameFolder pinned) =>
        "{\"output\": \"Mod\", \"packages\": [{\"gameFolder\":\"Fallout 4\",\"hash\":\""
        + FileHash.OfFilesTaken([.. pinned.Files.Select(file => new HashedFile(file.Path, file.Hash))])
        + "\"}], \"files\": [{\"path\":\"textures/a.dds\"}]}";

    private InstallationFile Pack(params (string Path, string Text)[] entries) => DownloadedZip.WritePack(Path.Combine(_root, "downloads"), entries);

    private const string WithAStep =
        "{\"output\": \"Mod\", \"steps\": [{\"task\": \"Optimise textures\", \"args\": [\"textures\"]}], "
        + "\"tools\": [{\"task\": \"Optimise textures\", \"page\": \"https://example.com/optimiser\"}], "
        + "\"files\": [{\"path\": \"textures/a.dds\", \"madeByStep\": true}]}";

    private InstanceToBuild WithItsTask => _noArchives with { Tasks = new HashSet<string>(StringComparer.Ordinal) { "Optimise textures" } };

    private void WriteSourceText(string manifest, params (string Path, string Text)[] assets)
    {
        Write(SourceFolder, $"{ModName}.manifest.json", Encoding.UTF8.GetBytes(manifest));
        foreach (var (path, text) in assets) WriteAsset(path, Encoding.UTF8.GetBytes(text));
    }

    private void WriteSource(string configuration, params (string Path, string Text)[] assets)
    {
        var output = System.Text.Json.Nodes.JsonNode.Parse(configuration)?["output"]?.GetValue<string>();
        Write(SourceFolder, $"{output}.manifest.json", Encoding.UTF8.GetBytes(configuration[..^1] + ", \"files\": []}"));
        foreach (var (path, text) in assets) WriteAsset(path, Encoding.UTF8.GetBytes(text));
    }

    private string Shared()
    {
        GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "init", "-q", "-b", "main");
        GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "remote", "add", "origin", Remote);
        GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "add", "-A");
        GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "commit", "-q", "-m", "Source");
        return GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "rev-parse", "HEAD").Trim();
    }

    private Manifest? ManifestWritten() => new ModFolderRepository(TimeProvider.System).ReadSourceManifest(SourceFolder).Value();

    private ModStatus Status() =>
        new ModFolderRepository(TimeProvider.System).Status(ModFolder, ModName, new HashSet<string> { MetaIni }, StatCache, held: null, SourceFolder);

    private void WriteAsset(string path, byte[] bytes) => Write(Path.Combine(SourceFolder, "assets"), path, bytes);

    private void WriteInFolder(string path, string text) => Write(ModFolder, path, Encoding.UTF8.GetBytes(text));

    private static void Write(string folder, string path, byte[] bytes)
    {
        var file = Path.Combine(folder, path);
        Directory.CreateDirectory(Path.GetDirectoryName(file).Require());
        File.WriteAllBytes(file, bytes);
    }

    private static (string Path, string Text)[] FilesIn(string folder) =>
        [.. Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories)
            .Select(file => (Path.GetRelativePath(folder, file).Replace('\\', '/'), File.ReadAllText(file)))
            .Where(file => file.Item1 != $"{ModName}.manifest.json")
            .OrderBy(file => file.Item1, StringComparer.Ordinal)];
}
