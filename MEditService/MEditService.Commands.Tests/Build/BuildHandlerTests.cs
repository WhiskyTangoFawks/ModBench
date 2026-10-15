using System.Text;
using MEditService.Commands.Build;
using MEditService.Commands.Edits;
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

public sealed class BuildHandlerTests : IDisposable
{
    private const string ModName = "Mod";
    private const string Installed = "Mod-1.zip";
    private const string Suffix = ".mohidden";
    private const string MetaIni = "meta.ini";
    private const string Remote = "https://example.com/mod.git";

    private readonly InstanceToBuild _noArchives;

    private readonly ScratchDirectory _root = new("medit-build-handler-");
    private readonly LoadOrderHolder _holder = new();

    public BuildHandlerTests() => _noArchives = new(Suffix, Archives: null, StatCache);

    public void Dispose() => _root.Dispose();

    private string StatCache => Path.Combine(_root, "stat-cache");

    private string ModFolder => Path.Combine(_root, "mods", ModName);

    private string SourceFolder => Path.Combine(_root, "source", ModName);

    private string Downloaded => Path.Combine(_root, "downloads", Installed);

    [Fact]
    public async Task Build_WritesTheBaseFromTheInstallationFilesPathForPath_AndTheAssetsOverIt()
    {
        var installed = Download(("textures/a.dds", "installed a"), ("textures/b.dds", "installed b"));
        WriteSource("{\"output\": \"Mod\"}", ("textures/b.dds", "edited b"), ("meshes/c.nif", "added c"));
        WriteInFolder("textures/a.dds", "changed in the folder");
        WriteInFolder("textures/b.dds", "edited b");

        var built = await Landed(installed);

        Assert.Equal(
            [("meshes/c.nif", "added c"), ("textures/a.dds", "installed a"), ("textures/b.dds", "edited b")],
            FilesIn(ModFolder));
        Assert.Equal(["textures/a.dds"], built.Overwritten);
    }

    [Theory]
    [InlineData("a FOMOD's choice", "00 Core/textures/a.dds", "textures/a.dds")]
    [InlineData("a file deleted after install", "textures/gone.dds", "textures/a.dds")]
    public async Task AFolderThatDoesNotHoldItsInstallationFilesAtTheirPaths_IsRefused_GuessingNoBase(string layout, string entry, string inFolder)
    {
        var installed = Download((entry, "installed"), ("textures/a.dds", "installed a"));
        WriteSource("{\"output\": \"Mod\"}");
        WriteInFolder(inFolder, "installed a");

        var refused = Assert.Single((await Build(_noArchives, installed)).Refused);

        Assert.True(refused.Refusal == BuildRefusal.BaseNotKnown, layout);
        Assert.Equal(
            $"'{ModName}' was not built: '{Installed}' installs '{entry}', which its folder does not hold at that path, so build cannot yet tell where its files come from.",
            refused.Message);
        Assert.Equal([(inFolder, "installed a")], FilesIn(ModFolder));
    }

    [Fact]
    public async Task AnInstallationFileGoneFromItsPath_RefusesTheMod_NamingThePath_WritingNothing()
    {
        var installed = Download(("a.txt", "a"));
        File.Delete(Downloaded);
        WriteSource("{\"output\": \"Mod\"}", ("meshes/c.nif", "c"));

        var refused = Assert.Single((await Build(_noArchives, installed)).Refused);

        Assert.Equal(BuildRefusal.InstallationFileMissing, refused.Refusal);
        Assert.Equal($"'{ModName}' was not built: its installation file '{Downloaded}' is gone.", refused.Message);
        Assert.False(Directory.Exists(ModFolder));
    }

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

    [Fact]
    public async Task ASourceWithNoRemote_IsRecordedAsAnyOtherMod_AFileTheInstallationFilesDoNotYieldHavingNoProvider()
    {
        var installed = Download(("textures/a.dds", "installed a"));
        WriteSource("{\"output\": \"Mod\"}", ("meshes/c.nif", "added c"));
        WriteInFolder("textures/a.dds", "installed a");
        WriteInFolder(MetaIni, "[General]");
        WriteInFolder("notes.txt", "mine");

        await Landed(installed);

        var manifest = ManifestWritten().Require();
        Assert.Equal([new ManifestSource(Installed, installed.Size, installed.Hash)], manifest.InstallationFiles);
        Assert.Equal(
            [new ManifestFile("meshes/c.nif", new FileProvider.NoProvider()), new ManifestFile("textures/a.dds", new FileProvider.FirstInstallationFile())],
            manifest.Files);
    }

    [Fact]
    public async Task ASourceWithARemote_NamesTheRemoteAndTheCommitForEachFileItProvides()
    {
        var installed = Download(("textures/a.dds", "installed a"));
        WriteSource("{\"output\": \"Mod\"}", ("meshes/c.nif", "added c"));
        WriteInFolder("textures/a.dds", "installed a");
        var commit = Shared();

        await Landed(installed);

        Assert.Equal(
            [new ManifestFile("meshes/c.nif", new FileProvider.Source(Remote, commit)), new ManifestFile("textures/a.dds", new FileProvider.FirstInstallationFile())],
            ManifestWritten().Require().Files);
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
    public async Task AManifestLineThatNamesNoInstallationFile_DoesNotStandForTheBase()
    {
        var installed = Download(("textures/a.dds", "installed a"));
        WriteSource("{\"output\": \"Mod\"}");
        WriteInFolder(MetaIni, "[General]");
        new ModFolderRepository(TimeProvider.System).WriteManifest(ModFolder, ModName, new Manifest(
            [new ManifestSource(Installed, installed.Size, installed.Hash)], [], [new ManifestFile("textures/a.dds", new FileProvider.NoProvider())]));

        Assert.Equal(BuildRefusal.BaseNotKnown, Assert.Single((await Build(_noArchives, installed)).Refused).Refusal);
    }

    [Fact]
    public async Task AJustBuiltMod_DiffersFromItsManifestOnlyByTheFilesTheBuildDidNotMake()
    {
        var installed = Download(("textures/a.dds", "installed a"));
        WriteSource("{\"output\": \"Mod\"}", ("meshes/c.nif", "added c"));
        WriteInFolder("textures/a.dds", "installed a");
        WriteInFolder(MetaIni, "[General]");
        WriteInFolder("notes.txt", "mine");
        Shared();

        await Landed(installed);

        Assert.Equal(new ModStatus(ModName, NoManifest: false, [], ["notes.txt"], [], []), Status());
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
    public async Task Build_WritesAnExcludedFile_AndEachFileOfAnExcludedFolder_UnderTheSuffix()
    {
        WriteSource("{\"output\": \"Mod\", \"exclude\": [\"Textures/A.dds\", \"meshes\"]}",
            ("textures/a.dds", "a"), ("textures/b.dds", "b"), ("meshes/deep/c.nif", "c"));

        await Landed();

        Assert.Equal([("meshes.mohidden/deep/c.nif", "c"), ("textures/a.dds.mohidden", "a"), ("textures/b.dds", "b")], FilesIn(ModFolder));
    }

    [Fact]
    public async Task AModWhoseSourceFolderHoldsNoBuildConfiguration_IsRefused_WritingNothing()
    {
        Directory.CreateDirectory(SourceFolder);

        var refused = Assert.Single((await Build(_noArchives)).Refused);

        Assert.Equal(BuildRefusal.SourceUnreadable, refused.Refusal);
        Assert.Equal($"'{ModName}' was not built: '{SourceFolder}' holds no build configuration.", refused.Message);
        Assert.False(Directory.Exists(ModFolder));
    }

    [Theory]
    [InlineData("{\"output\": \"Other\"}", BuildRefusal.OutputNotThisMod,
        "its build configuration names the output folder 'Other', not its folder 'Mod'.")]
    [InlineData("{\"output\": \"Mod\", \"archives\": {\"Mod - Main.ba2\": [\"meshes/c.nif\", \"a.txt\"]}}", BuildRefusal.ArchiveFileNotAnAsset,
        "'Mod - Main.ba2' takes 'a.txt', which is not an asset of its source.")]
    public async Task ABuildThatCannotMakeTheFolderTheConfigurationSays_RefusesTheMod_WritingNothing(
        string configuration, BuildRefusal refusal, string why)
    {
        var installed = Download(("a.txt", "a"));
        WriteSource(configuration, ("meshes/c.nif", "c"));

        var result = await Build(_noArchives, installed);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(refusal, refused.Refusal);
        Assert.StartsWith($"'{ModName}' was not built: ", refused.Message, StringComparison.Ordinal);
        Assert.EndsWith(why, refused.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(ModFolder));
    }

    [PosixFact]
    public async Task AFileThatCannotBeReadAfterTheFirstWrite_LandsTheBuildWithThatFailure_NamingWhatItOverwroteSoFar()
    {
        WriteSource("{\"output\": \"Mod\"}", ("a.txt", "a"), ("z.txt", "z"));
        WriteInFolder("a.txt", "changed in the folder");
        var held = Path.Combine(SourceFolder, "assets", "z.txt");
        FileModes.Set(held, "000");
        BuiltMod built;
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
        Assert.Null(ManifestWritten());
    }

    [Fact]
    public async Task Build_PacksEachArchiveFromItsAssets_TexturesAsTheTexturesVariant_LeavingNoneOfThemLoose()
    {
        WriteSource(
            "{\"output\": \"Mod\", \"archives\": {\"Mod - Main.ba2\": [\"meshes/c.nif\"], \"Mod - Textures.ba2\": [\"textures/a.dds\"]}}",
            ("meshes/c.nif", "c"), ("readme.txt", "loose"));
        WriteAsset("textures/a.dds", Dds.Dxt1(8, 8, 1).File);

        var built = await Landed(new InstanceToBuild(Suffix, new ArchiveVariants(
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

        var built = Assert.Single((await TestEditService.BuildHandler(_holder)
            .BuildAsync([new ModToBuild(ModName, SourceFolder, ModFolder, [], [MetaIni], null)], _noArchives)).Landed).Outcome;

        Assert.Equal(["Fixture.esp", $"Strings/{Path.GetFileName(stringsFiles[0])}"], built.Overwritten);
    }

    [Fact]
    public async Task ACompiledPlugin_AndItsStrings_AreNamedAsWhatItsSourceProvides_AndDoNotDiffer()
    {
        await InitializedWithALocalizedPlugin();
        GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "remote", "add", "origin", Remote);
        var commit = GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "rev-parse", "HEAD").Trim();

        Assert.Single((await TestEditService.BuildHandler(_holder)
            .BuildAsync([new ModToBuild(ModName, SourceFolder, ModFolder, [], [MetaIni], null)], _noArchives)).Landed);

        var stringsFiles = Directory.GetFiles(Path.Combine(ModFolder, "Strings")).Select(file => $"Strings/{Path.GetFileName(file)}");
        Assert.Equal(
            [.. new[] { "Fixture.esp" }.Concat(stringsFiles).Order(StringComparer.Ordinal).Select(path => new ManifestFile(path, new FileProvider.Source(Remote, commit)))],
            ManifestWritten().Require().Files);
        Assert.Empty(Status().Differing);
    }

    [Fact]
    public async Task AFreshClone_WithNoPluginFile_BuildsEachPluginFromItsSource()
    {
        await InitializedWithALocalizedPlugin();
        Directory.Delete(ModFolder, recursive: true);
        WriteInFolder(MetaIni, "[General]");
        _holder.Apply(SnapshotPlugins.Snapshot(Path.Combine(_root, "game"), _root, GameRelease.Fallout4, []));

        var built = Assert.Single((await TestEditService.BuildHandler(_holder)
            .BuildAsync([new ModToBuild(ModName, SourceFolder, ModFolder, [], [MetaIni], null)], _noArchives)).Landed).Outcome;

        Assert.Equal(["Fixture.esp"], built.Compiled.Select(plugin => plugin.Item.Name));
        Assert.True(File.Exists(Path.Combine(ModFolder, "Fixture.esp")));
    }

    [Fact]
    public async Task AFreshClonesFolder_ThatHoldsNoInstallationFile_BuildsTheBaseItsManifestNames()
    {
        var installed = Download(("textures/a.dds", "installed a"), ("textures/b.dds", "installed b"));
        WriteSource("{\"output\": \"Mod\"}", ("textures/b.dds", "edited b"));
        WriteInFolder(MetaIni, "[General]");
        new ModFolderRepository(TimeProvider.System).WriteManifest(ModFolder, ModName, new Manifest(
            [new ManifestSource(Installed, installed.Size, installed.Hash)], [],
            [new ManifestFile("textures/a.dds", new FileProvider.FirstInstallationFile()), new ManifestFile("textures/b.dds", new FileProvider.NoProvider())]));

        await Landed(installed);

        Assert.Equal([(MetaIni, "[General]"), ("textures/a.dds", "installed a"), ("textures/b.dds", "edited b")], FilesIn(ModFolder));
    }

    [Fact]
    public async Task TheModsVersionAndInstallationSources_AreInTheManifestTheBuildWrites()
    {
        var installed = Download(("textures/a.dds", "installed a")) with { Source = "nexus:fallout4:1;1:2" };
        WriteSource("{\"output\": \"Mod\"}");
        WriteInFolder("textures/a.dds", "installed a");
        WriteInFolder(MetaIni, "[General]");

        _holder.Apply(SnapshotPlugins.Snapshot(_root, _root, GameRelease.Fallout4, []));
        var built = await TestEditService.BuildHandler(_holder)
            .BuildAsync([new ModToBuild(ModName, SourceFolder, ModFolder, [installed], [MetaIni], "1.2.3")], _noArchives);

        Assert.Empty(built.Refused);

        var manifest = new ModFolderRepository(TimeProvider.System).ReadManifest(ModFolder, ModName).Require();
        Assert.Equal(("1.2.3", "nexus:fallout4:1;1:2"), (manifest.Version, manifest.InstallationFiles.Single().Source));
    }

    private async Task InitializedWithALocalizedPlugin()
    {
        var plugin = Path.Combine(Directory.CreateDirectory(ModFolder).FullName, "Fixture.esp");
        var written = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        written.Doors.AddNew("FixtureDoor").Name = new TranslatedString(Language.English, "The Big Door");
        written.UsingLocalization = true;
        written.WriteToBinary(plugin);
        var provider = new PluginProvider.FromMod(ModName, ModFolder, SourceFolder);
        _holder.Apply(SnapshotPlugins.Snapshot(Directory.CreateDirectory(Path.Combine(_root, "game")).FullName, _root, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", plugin, ModName, 0, Enabled: true, Winning: true, NamedProvider: provider)]));
        Assert.Single((await TestEditService.InitHandler(_holder).InitAsync([new ModToInit(ModName, SourceFolder, [], [])])).Landed);
    }

    private async Task<BuiltMod> Landed(params InstallationFile[] installed) => await Landed(_noArchives, installed);

    private async Task<BuiltMod> Landed(InstanceToBuild instance, params InstallationFile[] installed)
    {
        var result = await Build(instance, installed);
        Assert.Empty(result.Refused);
        return Assert.Single(result.Landed).Outcome;
    }

    private Task<SelectionResult<string, BuildRefusal, BuiltMod>> Build(InstanceToBuild instance, params InstallationFile[] installed)
    {
        _holder.Apply(SnapshotPlugins.Snapshot(_root, _root, GameRelease.Fallout4, []));
        return TestEditService.BuildHandler(_holder).BuildAsync([new ModToBuild(ModName, SourceFolder, ModFolder, installed, [MetaIni], null)], instance);
    }

    private InstallationFile Download(params (string Path, string Text)[] entries) => DownloadedZip.At(Downloaded, _root, entries);

    private void WriteSource(string configuration, params (string Path, string Text)[] assets)
    {
        Write(SourceFolder, "build.json", Encoding.UTF8.GetBytes(configuration));
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

    private Manifest? ManifestWritten() => new ModFolderRepository(TimeProvider.System).ReadManifest(ModFolder, ModName);

    private ModStatus Status() => new ModFolderRepository(TimeProvider.System).Status(ModFolder, ModName, new HashSet<string> { MetaIni }, StatCache);

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
            .Where(file => file.Item1 != $"{ModName}.manifest")
            .OrderBy(file => file.Item1, StringComparer.Ordinal)];
}
