using System.Text;
using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
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

    private static readonly InstanceToBuild NoArchives = new(ExclusionMark, Archives: null);

    private readonly ScratchDirectory _root = new("medit-build-handler-");
    private readonly LoadOrderHolder _holder = new();

    public void Dispose() => _root.Dispose();

    private string ModFolder => Path.Combine(_root, "mods", ModName);

    private const string SourceFolderName = "Mod Source";

    private string SourceFolder => Path.Combine(_root, "source", SourceFolderName);

    [Fact]
    public async Task Build_LeavesAFileItDidNotMake_AndNamesEachFileItReplacedThatHeldOtherBytes()
    {
        WriteSource(("textures/a.dds", "a"), ("meshes/c.nif", "c"));
        WriteInFolder("textures/a.dds", "changed in the folder");
        WriteInFolder("meshes/c.nif", "c");
        WriteInFolder("notes.txt", "mine");

        var built = await Landed();

        Assert.Equal([("meshes/c.nif", "c"), ("notes.txt", "mine"), ("textures/a.dds", "a")], FilesIn(ModFolder));
        Assert.Equal(["textures/a.dds"], built.Overwritten);
    }

    [Fact]
    public async Task ABuild_AnswersEachFileItMade_ByItsPathInTheFolder_AndWritesNoManifest()
    {
        WriteSource(("meshes/c.nif", "c"), ("textures/a.dds", "a"));
        WriteInFolder(MetaIni, "[General]");
        var sourceBefore = Directory.GetFiles(SourceFolder, "*", SearchOption.AllDirectories);

        var built = await Landed(new ModToBuild(ModName, SourceFolder, ModFolder) { Exclude = ["textures/a.dds"] });

        Assert.Equal([new MadeFile("meshes/c.nif", VouchedFor: true), new MadeFile("textures/a.dds.excluded", VouchedFor: true)], built.Made);
        Assert.Equal(sourceBefore, Directory.GetFiles(SourceFolder, "*", SearchOption.AllDirectories));
        Assert.Empty(Directory.GetFiles(ModFolder, "*.manifest.json"));
    }

    [Theory]
    [InlineData("assets/meshes/c.nif", "changed", true)]
    [InlineData("assets/meshes/c.nif", "c", false)]
    public async Task ABuildFromASharedSource_SaysWhenItsSourceHoldsChangesNoCommitHolds(string written, string text, bool uncommitted)
    {
        WriteSource(("meshes/c.nif", "c"));
        Shared();
        Write(SourceFolder, written, Encoding.UTF8.GetBytes(text));

        Assert.Equal(uncommitted, (await Landed()).Uncommitted);
    }

    [Theory]
    [InlineData("refs/remotes/origin/main", false)]
    [InlineData("refs/heads/kept", true)]
    public async Task ABuildAtACommitItsRemoteDoesNotHold_SaysSo(string holding, bool unpushed)
    {
        WriteSource(("meshes/c.nif", "c"));
        Shared();
        GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "update-ref", holding, "HEAD");

        Assert.Equal(unpushed, (await Landed()).Unpushed);
    }

    [PosixFact]
    public async Task TwoPluginSourcesWhoseNamesDifferInCaseAlone_AreEachRefusedByName_AndTheRestOfTheModBuilds()
    {
        WriteSource(("meshes/c.nif", "c"));
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
    public async Task Build_WritesAnExcludedFile_AndEachFileOfAnExcludedFolder_UnderTheExclusionMarkHanded()
    {
        WriteSource(("textures/a.dds", "a"), ("textures/b.dds", "b"), ("meshes/deep/c.nif", "c"));

        await Landed(new ModToBuild(ModName, SourceFolder, ModFolder) { Exclude = ["Textures/A.dds", "meshes"] });

        Assert.Equal([("meshes.excluded/deep/c.nif", "c"), ("textures/a.dds.excluded", "a"), ("textures/b.dds", "b")], FilesIn(ModFolder));
    }

    [Fact]
    public async Task AnArchiveTakingAFileThatIsNeitherAnAssetNorTaken_RefusesTheMod_WritingNothing()
    {
        WriteSource(("meshes/c.nif", "c"));

        var refused = Assert.Single((await Build(new ModToBuild(ModName, SourceFolder, ModFolder)
        {
            Archives = [new ArchiveToPack("Mod - Main.ba2", ["meshes/c.nif", "a.txt"])],
        })).Refused);

        Assert.Equal(
            (BuildRefusal.ArchiveFileNotAnAsset, "was not built: 'Mod - Main.ba2' takes 'a.txt', which is not an asset of its source."),
            (refused.Refusal, refused.Message));
        Assert.False(Directory.Exists(ModFolder));
    }

    [PosixFact]
    public async Task AFileThatCannotBeReadAfterTheFirstWrite_LandsTheBuildWithThatFailure_NamingWhatItOverwroteSoFar()
    {
        WriteSource(("a.txt", "a"), ("z.txt", "z"));
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
        Assert.Empty(built.Made);
    }

    [Fact]
    public async Task Build_PacksEachArchiveFromItsAssets_TexturesAsTheTexturesVariant_LeavingNoneOfThemLoose()
    {
        WriteSource(("meshes/c.nif", "c"), ("readme.txt", "loose"));
        WriteAsset("textures/a.dds", Dds.Dxt1(8, 8, 1).File);

        var built = await Landed(new ModToBuild(ModName, SourceFolder, ModFolder)
        {
            Archives = [new ArchiveToPack("Mod - Main.ba2", ["meshes/c.nif"]), new ArchiveToPack("Mod - Textures.ba2", ["textures/a.dds"])],
        }, Packing);

        Assert.Empty(built.ArchivesRefused);
        Assert.Equal(["Mod - Main.ba2", "Mod - Textures.ba2", "readme.txt"], FilesIn(ModFolder).Select(file => file.Path));
        Assert.Equal("GNRL", Encoding.ASCII.GetString(File.ReadAllBytes(Path.Combine(ModFolder, "Mod - Main.ba2")), 8, 4));
        Assert.Equal("DX10", Encoding.ASCII.GetString(File.ReadAllBytes(Path.Combine(ModFolder, "Mod - Textures.ba2")), 8, 4));
    }

    [Fact]
    public async Task AGameWhoseTableNamesNoArchiveVariant_RefusesEachArchive_AndBuildsTheRest()
    {
        WriteSource(("meshes/c.nif", "c"), ("readme.txt", "loose"));

        var built = await Landed(new ModToBuild(ModName, SourceFolder, ModFolder) { Archives = [new ArchiveToPack("Mod - Main.ba2", ["meshes/c.nif"])] });

        var refused = Assert.Single(built.ArchivesRefused);
        Assert.Equal(("Mod - Main.ba2", ArchiveRefusal.VariantNotWritten), (refused.Item, refused.Refusal));
        Assert.Equal([("readme.txt", "loose")], FilesIn(ModFolder));
        Assert.Contains(new MadeFile("Mod - Main.ba2", VouchedFor: false), built.Made);
    }

    [Fact]
    public async Task APluginChangedOutsideModbench_IsNamedOverwritten_WithEachOfItsStringsFilesThatDiffered()
    {
        await InitializedWithALocalizedPlugin();
        var stringsFiles = Directory.GetFiles(Path.Combine(ModFolder, "Strings")).Order(StringComparer.Ordinal).ToList();
        File.AppendAllText(Path.Combine(ModFolder, "Fixture.esp"), "changed outside Modbench");
        File.WriteAllText(stringsFiles[0], "changed outside Modbench");

        var built = Assert.Single((await TestEditService.BuildModHandler(_holder)
            .BuildAsync([new ModToBuild(ModName, SourceFolder, ModFolder)], NoArchives)).Value().Applied);

        Assert.Equal(["Fixture.esp", $"Strings/{Path.GetFileName(stringsFiles[0])}"], built.Overwritten);
    }

    [Fact]
    public async Task ACompiledPlugin_AndItsStrings_AreMade_VouchedForByItsSource()
    {
        await InitializedWithALocalizedPlugin();

        var built = Assert.Single((await TestEditService.BuildModHandler(_holder)
            .BuildAsync([new ModToBuild(ModName, SourceFolder, ModFolder)], NoArchives)).Value().Applied);

        var stringsFiles = Directory.GetFiles(Path.Combine(ModFolder, "Strings")).Select(file => $"Strings/{Path.GetFileName(file)}");
        Assert.Equal(
            [.. new[] { "Fixture.esp" }.Concat(stringsFiles).Order(StringComparer.Ordinal).Select(path => new MadeFile(path, VouchedFor: true))],
            built.Made);
    }

    [Fact]
    public async Task AFreshClone_WithNoPluginFile_BuildsEachPluginFromItsSource()
    {
        await InitializedWithALocalizedPlugin();
        Directory.Delete(ModFolder, recursive: true);
        WriteInFolder(MetaIni, "[General]");
        _holder.Apply(SnapshotPlugins.Snapshot(Path.Combine(_root, "Data"), _root, GameRelease.Fallout4, []));

        var built = Assert.Single((await TestEditService.BuildModHandler(_holder)
            .BuildAsync([new ModToBuild(ModName, SourceFolder, ModFolder)], NoArchives)).Value().Applied);

        Assert.Equal(["Fixture.esp"], built.Compiled.Select(plugin => plugin.Name));
        Assert.True(File.Exists(Path.Combine(ModFolder, "Fixture.esp")));
    }

    [Fact]
    public async Task ATakenFile_IsNotReplacedByTheSourcesPlaceholder_NorAnswered()
    {
        WriteSource(("textures/a.dds", "placeholder"), ("meshes/c.nif", "c"));
        WriteInFolder("textures/a.dds", "from the pack");

        var built = await Landed(new ModToBuild(ModName, SourceFolder, ModFolder) { Taken = ["textures/a.dds"] });

        Assert.Equal([("meshes/c.nif", "c"), ("textures/a.dds", "from the pack")], FilesIn(ModFolder));
        Assert.Equal([new MadeFile("meshes/c.nif", VouchedFor: true)], built.Made);
    }

    [Fact]
    public async Task AnArchive_PacksATakenFile_LeavingNoLooseCopy()
    {
        WriteSource(("meshes/d.nif", "d"));
        WriteInFolder("meshes/c.nif", "from the pack");

        var built = await Landed(new ModToBuild(ModName, SourceFolder, ModFolder)
        {
            Archives = [new ArchiveToPack("Mod - Main.ba2", ["meshes/c.nif", "meshes/d.nif"])],
            Taken = ["meshes/c.nif"],
        }, Packing);

        Assert.Empty(built.ArchivesRefused);
        Assert.Equal(["Mod - Main.ba2"], FilesIn(ModFolder).Select(file => file.Path));
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
        Assert.Single((await TestEditService.DecompileAndCommitModHandler(_holder).DecompileAndCommitAsync([new ModToDecompileAndCommit(ModName, new NewRepository(SourceFolder, [], SourceInits.ManifestOf(ModName)))])).Value().Applied);
    }

    private async Task<ModBuilt> Landed() => await Landed(new ModToBuild(ModName, SourceFolder, ModFolder));

    private async Task<ModBuilt> Landed(ModToBuild mod, InstanceToBuild? instance = null)
    {
        var result = await Build(mod, instance);
        Assert.Empty(result.Refused);
        return Assert.Single(result.Applied);
    }

    private async Task<BuildResult> Build(ModToBuild mod, InstanceToBuild? instance = null)
    {
        _holder.Apply(SnapshotPlugins.Snapshot(_root, _root, GameRelease.Fallout4, []));
        return (await TestEditService.BuildModHandler(_holder).BuildAsync([mod], instance ?? NoArchives)).Value();
    }

    private static readonly InstanceToBuild Packing = new(ExclusionMark, new ArchiveVariants(
        new Ba2Variant(1, Ba2Contents.General, Compressed: false), new Ba2Variant(1, Ba2Contents.Textures, Compressed: false)));

    private void WriteSource(params (string Path, string Text)[] assets)
    {
        Directory.CreateDirectory(SourceFolder);
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
