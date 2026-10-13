using System.IO.Compression;
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

namespace MEditService.Commands.Tests.Build;

public sealed class BuildHandlerTests : IDisposable
{
    private const string ModName = "Mod";
    private const string Installed = "Mod-1.zip";
    private const string Suffix = ".mohidden";

    private static readonly InstanceToBuild NoArchives = new(Suffix, Archives: null);

    private readonly ScratchDirectory _root = new("medit-build-handler-");
    private readonly LoadOrderHolder _holder = new();

    public void Dispose() => _root.Dispose();

    private string ModFolder => Path.Combine(_root, "mods", ModName);

    private string SourceFolder => Path.Combine(_root, "source", ModName);

    private string Downloaded => Path.Combine(_root, "downloads", Installed);

    [Fact]
    public async Task Build_WritesTheBaseFromItsEntriesInTheInstallationFile_AndTheAssetsOverIt()
    {
        var installed = Download(("00 Core/textures/a.dds", "installed a"), ("00 Core/textures/b.dds", "installed b"), ("fomod/ModuleConfig.xml", "steps"));
        WriteSource("""
            {"output": "Mod", "base": {"Mod-1.zip": {"textures/a.dds": "00 Core/textures/a.dds", "textures/b.dds": "00 Core/textures/b.dds"}}}
            """, ("textures/b.dds", "edited b"), ("meshes/c.nif", "added c"));

        var built = await Landed(installed);

        Assert.Equal(
            [("meshes/c.nif", "added c"), ("textures/a.dds", "installed a"), ("textures/b.dds", "edited b")],
            FilesIn(ModFolder));
        Assert.Empty(built.Overwritten);
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
    public async Task Build_WritesAnExcludedFile_AndEachFileOfAnExcludedFolder_UnderTheSuffix()
    {
        WriteSource("{\"output\": \"Mod\", \"exclude\": [\"Textures/A.dds\", \"meshes\"]}",
            ("textures/a.dds", "a"), ("textures/b.dds", "b"), ("meshes/deep/c.nif", "c"));

        await Landed();

        Assert.Equal([("meshes.mohidden/deep/c.nif", "c"), ("textures/a.dds.mohidden", "a"), ("textures/b.dds", "b")], FilesIn(ModFolder));
    }

    [Theory]
    [InlineData(null, BuildRefusal.SourceUnreadable, "holds no build configuration.")]
    [InlineData("{\"output\": \"Other\"}", BuildRefusal.OutputNotThisMod,
        "its build configuration names the output folder 'Other', not its folder 'Mod'.")]
    [InlineData("{\"output\": \"Mod\", \"base\": {\"Mod-2.zip\": {\"a.txt\": \"a.txt\"}}}", BuildRefusal.InstallationFileMissing,
        "its base comes from 'Mod-2.zip', which is not among its installation files in the downloads folder.")]
    [InlineData("{\"output\": \"Mod\", \"base\": {\"Mod-1.zip\": {\"a.txt\": \"00 Core/a.txt\"}}}", BuildRefusal.EntryMissing,
        "'Mod-1.zip' holds no '00 Core/a.txt', which its base takes for 'a.txt'.")]
    [InlineData("{\"output\": \"Mod\", \"archives\": {\"Mod - Main.ba2\": [\"meshes/c.nif\", \"a.txt\"]}}", BuildRefusal.ArchiveFileNotAnAsset,
        "'Mod - Main.ba2' takes 'a.txt', which is not an asset of its source.")]
    public async Task ABuildThatCannotMakeTheFolderTheConfigurationSays_RefusesTheMod_WritingNothing(
        string? configuration, BuildRefusal refusal, string why)
    {
        var installed = Download(("a.txt", "a"));
        if (configuration is null) Directory.CreateDirectory(SourceFolder);
        else WriteSource(configuration, ("meshes/c.nif", "c"));

        var result = await Build(NoArchives, installed);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(refusal, refused.Refusal);
        Assert.StartsWith($"'{ModName}' was not built: ", refused.Message, StringComparison.Ordinal);
        Assert.EndsWith(why, refused.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(ModFolder));
    }

    [Fact]
    public async Task Build_PacksEachArchiveFromItsAssets_TexturesAsTheTexturesVariant_LeavingNoneOfThemLoose()
    {
        WriteSource(
            "{\"output\": \"Mod\", \"archives\": {\"Mod - Main.ba2\": [\"meshes/c.nif\"], \"Mod - Textures.ba2\": [\"textures/a.dds\"]}}",
            ("meshes/c.nif", "c"), ("readme.txt", "loose"));
        WriteAsset("textures/a.dds", Dds.Dxt1(8, 8, 1).File);

        var built = await Landed(new InstanceToBuild(Suffix, new ArchiveVariants(
            new Ba2Variant(1, Ba2Contents.General, Compressed: false), new Ba2Variant(1, Ba2Contents.Textures, Compressed: false))));

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
    public async Task AModInitTookFromAnotherPathInItsInstallationFile_BuildsThatFileBackFromIt()
    {
        var plugin = Path.Combine(Directory.CreateDirectory(ModFolder).FullName, "Fixture.esp");
        var written = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        written.Npcs.AddNew("FixtureNpc");
        written.WriteToBinary(plugin);
        var provider = new PluginProvider.FromMod(ModName, ModFolder, SourceFolder);
        _holder.Apply(SnapshotPlugins.Snapshot(Directory.CreateDirectory(Path.Combine(_root, "game")).FullName, _root, GameRelease.Fallout4,
            [new LoadOrderEntry("Fixture.esp", plugin, ModName, 0, Enabled: true, Winning: true, NamedProvider: provider)]));
        WriteInFolder("textures/chosen.dds", "an option the installer chose");
        var installed = Download(("00 Core/textures/chosen.dds", "an option the installer chose"), ("01 Other/textures/chosen.dds", "not chosen"));
        Assert.Single((await TestEditService.InitHandler(_holder).InitAsync([new ModToInit(ModName, SourceFolder, [installed], [])])).Landed);
        WriteInFolder("textures/chosen.dds", "changed in the folder");

        var built = Assert.Single((await TestEditService.BuildHandler(_holder)
            .BuildAsync([new ModToBuild(ModName, SourceFolder, ModFolder, [installed])], NoArchives)).Landed).Outcome;

        Assert.Equal("an option the installer chose", File.ReadAllText(Path.Combine(ModFolder, "textures", "chosen.dds")));
        Assert.Equal(["textures/chosen.dds"], built.Overwritten);
        Assert.Equal([new PluginAddress("Fixture.esp", ModName)], built.Compiled.Select(compiled => compiled.Item));
    }

    private async Task<BuiltMod> Landed(params InstallationFile[] installed) => await Landed(NoArchives, installed);

    private async Task<BuiltMod> Landed(InstanceToBuild instance, params InstallationFile[] installed)
    {
        var result = await Build(instance, installed);
        Assert.Empty(result.Refused);
        return Assert.Single(result.Landed).Outcome;
    }

    private Task<SelectionResult<string, BuildRefusal, BuiltMod>> Build(InstanceToBuild instance, params InstallationFile[] installed)
    {
        _holder.Apply(SnapshotPlugins.Snapshot(_root, _root, GameRelease.Fallout4, []));
        return TestEditService.BuildHandler(_holder).BuildAsync([new ModToBuild(ModName, SourceFolder, ModFolder, installed)], instance);
    }

    private InstallationFile Download(params (string Path, string Text)[] entries)
    {
        var extracted = Directory.CreateDirectory(Path.Combine(_root, "extracted")).FullName;
        foreach (var (path, text) in entries) Write(extracted, path, Encoding.UTF8.GetBytes(text));
        Directory.CreateDirectory(Path.GetDirectoryName(Downloaded).Require());
        ZipFile.CreateFromDirectory(extracted, Downloaded);
        var hashedAsAModsFiles = new ModFolderRepository(TimeProvider.System).Files(extracted, "installed", new HashSet<string>());
        return new InstallationFile(
            Downloaded, Source: null, Size: new FileInfo(Downloaded).Length, Hash: "AAAAAAAAAAA=",
            [.. hashedAsAModsFiles.Select(entry => new HashedEntry(entry.Path, entry.Hash))]);
    }

    private void WriteSource(string configuration, params (string Path, string Text)[] assets)
    {
        Write(SourceFolder, "build.json", Encoding.UTF8.GetBytes(configuration));
        foreach (var (path, text) in assets) WriteAsset(path, Encoding.UTF8.GetBytes(text));
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
            .OrderBy(file => file.Item1, StringComparer.Ordinal)];
}
