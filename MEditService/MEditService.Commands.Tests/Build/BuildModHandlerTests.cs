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
    private const string Plugin = "Fixture.esp";
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
    public async Task ACopy_WritesEachFileOfAFolderAndAFileItNames_ReplacingOneThatHeldOtherBytes_AndLeavesTheRest()
    {
        WriteSource(("textures/a.dds", "a"), ("textures/deep/b.dds", "b"), ("meshes/c.nif", "c"), ("meshes/d.nif", "d"));
        WriteInFolder("textures/a.dds", "changed in the folder");
        WriteInFolder("notes.txt", "mine");

        var built = await Landed(Copy("textures", "meshes/c.nif"));

        Assert.Equal([("meshes/c.nif", "c"), ("notes.txt", "mine"), ("textures/a.dds", "a"), ("textures/deep/b.dds", "b")], FilesIn(ModFolder));
        Assert.Null(built.Failure);
    }

    [Fact]
    public async Task ACopy_AnswersEachFileItMade_ByItsPathInTheFolder_AndWritesNoManifest()
    {
        WriteSource(("meshes/c.nif", "c"), ("textures/a.dds", "a"));
        WriteInFolder(MetaIni, "[General]");
        var sourceBefore = Directory.GetFiles(SourceFolder, "*", SearchOption.AllDirectories);

        var built = await Landed(Copy("meshes", "textures") with { Exclude = ["textures/a.dds"] });

        Assert.Equal([new MadeFile("meshes/c.nif", VouchedFor: true), new MadeFile("textures/a.dds.excluded", VouchedFor: true)], built.Made);
        Assert.Equal(sourceBefore, Directory.GetFiles(SourceFolder, "*", SearchOption.AllDirectories));
        Assert.Empty(Directory.GetFiles(ModFolder, "*.manifest.json"));
    }

    [Fact]
    public async Task ACopyOfAPathTheSourceFolderDoesNotHold_RefusesTheMod_WritingNothing()
    {
        WriteSource(("meshes/c.nif", "c"));

        var refused = Assert.Single((await Build(Copy("meshes", "textures"))).Refused);

        Assert.Equal(
            (BuildRefusal.SourceUnreadable, $"'{SourceFolder}' holds no 'textures' to copy."), (refused.Refusal, refused.Message));
        Assert.False(Directory.Exists(ModFolder));
    }

    [Fact]
    public async Task ACopy_CompilesNoPlugin()
    {
        await InitializedWithALocalizedPlugin();
        WriteSource(("meshes/c.nif", "c"));
        File.Delete(Path.Combine(ModFolder, Plugin));

        var built = await Landed(Copy("meshes"));

        Assert.Empty(built.Compiled);
        Assert.False(File.Exists(Path.Combine(ModFolder, Plugin)));
    }

    [Theory]
    [InlineData("meshes/c.nif", "changed", true)]
    [InlineData("meshes/c.nif", "c", false)]
    public async Task ABuildFromASharedSource_SaysWhenItsSourceHoldsChangesNoCommitHolds(string written, string text, bool uncommitted)
    {
        WriteSource(("meshes/c.nif", "c"));
        Shared();
        Write(SourceFolder, written, Encoding.UTF8.GetBytes(text));

        Assert.Equal(uncommitted, (await Landed(Copy("meshes"))).Uncommitted);
    }

    [Theory]
    [InlineData("refs/remotes/origin/main", false)]
    [InlineData("refs/heads/kept", true)]
    public async Task ABuildAtACommitItsRemoteDoesNotHold_SaysSo(string holding, bool unpushed)
    {
        WriteSource(("meshes/c.nif", "c"));
        Shared();
        GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "update-ref", holding, "HEAD");

        Assert.Equal(unpushed, (await Landed(Copy("meshes"))).Unpushed);
    }

    [Fact]
    public async Task ACompileOfTwoPluginsWhoseNamesDifferInCaseAlone_RefusesEachByName()
    {
        WriteSource(("meshes/c.nif", "c"));

        var built = await Landed(new ModToBuild(ModName, SourceFolder, ModFolder, new BuildStep.Compile(["Fixture.esp", "fixture.esp"])));

        Assert.Equal(
            [
                ("Fixture.esp", CompileRefusal.TwinPluginSources,
                    "Fixture.esp cannot be compiled: the plugin sources 'Fixture.esp' and 'fixture.esp' differ only in case, and one mod folder cannot hold them on Windows."),
                ("fixture.esp", CompileRefusal.TwinPluginSources,
                    "fixture.esp cannot be compiled: the plugin sources 'Fixture.esp' and 'fixture.esp' differ only in case, and one mod folder cannot hold them on Windows."),
            ],
            built.Refused.Select(refused => (refused.Item.Name, refused.Refusal, refused.Message)));
        Assert.False(Directory.Exists(ModFolder));
    }

    [Fact]
    public async Task ACompileOfAPluginWithNoPluginSource_RefusesIt_NamingIt_AndCompilesTheRest()
    {
        await InitializedWithALocalizedPlugin();

        var built = await Landed(new ModToBuild(ModName, SourceFolder, ModFolder, new BuildStep.Compile([Plugin, "Other.esp"])));

        Assert.Equal(["Other.esp"], built.Refused.Select(refused => refused.Item.Name));
        Assert.Equal([Plugin], built.Compiled.Select(plugin => plugin.Name));
    }

    [Fact]
    public async Task ACopy_WritesAnExcludedFile_AndEachFileOfAnExcludedFolder_UnderTheExclusionMarkHanded()
    {
        WriteSource(("textures/a.dds", "a"), ("textures/b.dds", "b"), ("meshes/deep/c.nif", "c"));

        await Landed(Copy("textures", "meshes") with { Exclude = ["Textures/A.dds", "meshes"] });

        Assert.Equal([("meshes.excluded/deep/c.nif", "c"), ("textures/a.dds.excluded", "a"), ("textures/b.dds", "b")], FilesIn(ModFolder));
    }

    [Fact]
    public async Task APackTakingAFileItsFolderDoesNotHold_RefusesTheMod_WritingNothing()
    {
        WriteInFolder("meshes/c.nif", "c");

        var refused = Assert.Single((await Build(Pack(new ArchiveToPack("Mod - Main.ba2", ["meshes/c.nif", "a.txt"])), Packing)).Refused);

        Assert.Equal(
            (BuildRefusal.ArchiveFileNotInFolder, "'Mod - Main.ba2' takes 'a.txt', which its folder does not hold."),
            (refused.Refusal, refused.Message));
        Assert.Equal([("meshes/c.nif", "c")], FilesIn(ModFolder));
    }

    [Fact]
    public async Task ARefusedPack_WritesNothing_LeavingAFolderThatHoldsACompiledPluginAndItsStringsReadingAsNoChangeOutsideModbench()
    {
        await InitializedWithALocalizedPlugin();
        WriteInFolder("textures/taken.dds", "from the pack");
        var before = Directory.GetFiles(ModFolder, "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal)
            .Select(file => (file, Convert.ToHexString(File.ReadAllBytes(file)))).ToList();

        var result = (await TestEditService.BuildModHandler(_holder).BuildAsync(
            [Pack(new ArchiveToPack("Mod - Main.ba2", ["not-in-the-folder.nif"]))], NoArchives)).Value();

        Assert.Equal([BuildRefusal.ArchiveFileNotInFolder], result.Refused.Select(refused => refused.Refusal));
        Assert.Equal(before, Directory.GetFiles(ModFolder, "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal)
            .Select(file => (file, Convert.ToHexString(File.ReadAllBytes(file)))).ToList());
        Assert.Empty(ExternalChanges.NamedBy(_holder.Current));
    }

    [PosixFact]
    public async Task AFileThatCannotBeReadAfterTheFirstWrite_LandsTheCopyWithThatFailure()
    {
        WriteSource(("a.txt", "a"), ("z.txt", "z"));
        WriteInFolder("a.txt", "changed in the folder");
        var held = Path.Combine(SourceFolder, "z.txt");
        FileModes.Set(held, "000");
        ModBuilt built;
        try
        {
            built = await Landed(Copy("a.txt", "z.txt"));
        }
        finally
        {
            FileModes.Set(held, "600");
        }

        Assert.StartsWith("The build stopped at its copy, as a file could not be read or written: ", built.Failure, StringComparison.Ordinal);
        Assert.Contains("z.txt", built.Failure, StringComparison.Ordinal);
        Assert.Empty(built.Made);
    }

    [Fact]
    public async Task APack_PacksEachArchiveFromTheLooseFilesInItsFolder_TexturesAsTheTexturesVariant_AnsweringEachLooseFileItPacked()
    {
        WriteInFolder("meshes/c.nif", "c");
        WriteInFolder("readme.txt", "loose");
        Write(ModFolder, "textures/a.dds", Dds.Dxt1(8, 8, 1).File);

        var built = await Landed(Pack(new ArchiveToPack("Mod - Main.ba2", ["Meshes/C.nif"]), new ArchiveToPack("Mod - Textures.ba2", ["textures/a.dds"])), Packing);

        Assert.Empty(built.ArchivesRefused);
        Assert.Equal(["Mod - Main.ba2", "Mod - Textures.ba2", "meshes/c.nif", "readme.txt", "textures/a.dds"], FilesIn(ModFolder).Select(file => file.Path));
        Assert.Equal([new MadeFile("Mod - Main.ba2", VouchedFor: true), new MadeFile("Mod - Textures.ba2", VouchedFor: true)], built.Made);
        Assert.Equal(["meshes/c.nif", "textures/a.dds"], built.Packed);
        Assert.Equal("GNRL", Encoding.ASCII.GetString(File.ReadAllBytes(Path.Combine(ModFolder, "Mod - Main.ba2")), 8, 4));
        Assert.Equal("DX10", Encoding.ASCII.GetString(File.ReadAllBytes(Path.Combine(ModFolder, "Mod - Textures.ba2")), 8, 4));
    }

    [Fact]
    public async Task AGameWhoseTableNamesNoArchiveVariant_RefusesEachArchive_LeavingItsLooseFiles()
    {
        WriteInFolder("meshes/c.nif", "c");

        var built = await Landed(Pack(new ArchiveToPack("Mod - Main.ba2", ["meshes/c.nif"])));

        var refused = Assert.Single(built.ArchivesRefused);
        Assert.Equal(("Mod - Main.ba2", ArchiveRefusal.VariantNotWritten), (refused.Item, refused.Refusal));
        Assert.Equal([("meshes/c.nif", "c")], FilesIn(ModFolder));
        Assert.Equal([new MadeFile("Mod - Main.ba2", VouchedFor: false)], built.Made);
        Assert.Empty(built.Packed);
    }

    [Fact]
    public async Task ACompiledPlugin_AndItsStrings_AreMade_VouchedForByItsSource()
    {
        await InitializedWithALocalizedPlugin();

        var built = await Landed(Compile());

        var stringsFiles = Directory.GetFiles(Path.Combine(ModFolder, "Strings")).Select(file => $"Strings/{Path.GetFileName(file)}");
        Assert.Equal(
            [.. new[] { Plugin }.Concat(stringsFiles).Order(StringComparer.Ordinal).Select(path => new MadeFile(path, VouchedFor: true))],
            built.Made);
    }

    [Fact]
    public async Task AFreshClone_WithNoPluginFile_CompilesEachPluginFromItsSource()
    {
        await InitializedWithALocalizedPlugin();
        Directory.Delete(ModFolder, recursive: true);
        WriteInFolder(MetaIni, "[General]");

        var built = await Landed(Compile());

        Assert.Equal([Plugin], built.Compiled.Select(plugin => plugin.Name));
        Assert.True(File.Exists(Path.Combine(ModFolder, Plugin)));
    }

    [Fact]
    public async Task ADecompile_ReplacesThePluginSourceOfAPluginInTheSourceFolder_WhichTheCompileAfterBuilds()
    {
        await InitializedWithALocalizedPlugin();
        var replacement = new Fallout4Mod(ModKey.FromFileName(Plugin), Fallout4Release.Fallout4);
        replacement.Doors.AddNew("ReplacingDoor");
        replacement.WriteToBinary(Path.Combine(SourceFolder, Plugin));
        var before = SourceFilesOf(Plugin);

        var decompiled = await Landed(new ModToBuild(ModName, SourceFolder, ModFolder, new BuildStep.Decompile([Plugin])));
        await Landed(Compile());

        Assert.Equal((null, []), (decompiled.Failure, decompiled.Made));
        Assert.NotEqual(before, SourceFilesOf(Plugin));
        using var compiled = Fallout4Mod.CreateFromBinaryOverlay(new ModPath(ModKey.FromFileName(Plugin), Path.Combine(ModFolder, Plugin)), Fallout4Release.Fallout4);
        Assert.Equal(["ReplacingDoor"], compiled.Doors.Select(door => door.EditorID));
    }

    [Fact]
    public async Task ADecompile_AnswersWhereItMovedThePluginSourceItReplaced_KeepingItsName()
    {
        await InitializedWithALocalizedPlugin();
        var replacement = new Fallout4Mod(ModKey.FromFileName(Plugin), Fallout4Release.Fallout4);
        replacement.Doors.AddNew("ReplacingDoor");
        replacement.WriteToBinary(Path.Combine(SourceFolder, Plugin));
        var before = SourceFilesOf(Plugin).Select(file => (Path.GetRelativePath(Path.Combine(SourceFolder, "plugin-source", Plugin), file), File.ReadAllText(file))).ToList();

        var decompiled = await Landed(new ModToBuild(ModName, SourceFolder, ModFolder, new BuildStep.Decompile([Plugin])));

        var aside = Path.Combine(SourceFolder, Assert.Single(decompiled.Replaced));
        Assert.Equal(Plugin, Path.GetFileName(aside));
        Assert.Equal(before, Directory.GetFiles(aside, "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal).Select(file => (Path.GetRelativePath(aside, file), File.ReadAllText(file))));
    }

    [Fact]
    public async Task ADecompile_AlsoAnswersThePluginSourceAnEarlierBuildLeftAside_SoTheExtensionTrashesIt()
    {
        await InitializedWithALocalizedPlugin();
        var replacement = new Fallout4Mod(ModKey.FromFileName(Plugin), Fallout4Release.Fallout4);
        replacement.Doors.AddNew("ReplacingDoor");
        replacement.WriteToBinary(Path.Combine(SourceFolder, Plugin));
        var stranded = Assert.Single((await Landed(new ModToBuild(ModName, SourceFolder, ModFolder, new BuildStep.Decompile([Plugin])))).Replaced);

        var decompiled = await Landed(new ModToBuild(ModName, SourceFolder, ModFolder, new BuildStep.Decompile([Plugin])));

        Assert.Equal(2, decompiled.Replaced.Count);
        Assert.Contains(stranded, decompiled.Replaced);
    }

    [Fact]
    public async Task ADecompileRefusingItsSecondPlugin_WritesNoPluginSource()
    {
        await InitializedWithALocalizedPlugin();
        var replacement = new Fallout4Mod(ModKey.FromFileName(Plugin), Fallout4Release.Fallout4);
        replacement.Doors.AddNew("ReplacingDoor");
        replacement.WriteToBinary(Path.Combine(SourceFolder, Plugin));
        var before = SourceFilesOf(Plugin);

        var refused = Assert.Single((await Build(new ModToBuild(ModName, SourceFolder, ModFolder, new BuildStep.Decompile([Plugin, "Missing.esp"])))).Refused);

        Assert.Equal(BuildRefusal.NotDecompiled, refused.Refusal);
        Assert.Equal(before, SourceFilesOf(Plugin));
        Assert.Equal(["plugin-source"], Directory.GetDirectories(SourceFolder).Select(Path.GetFileName).Where(name => name != ".git"));
    }

    [Fact]
    public async Task ADecompileOfAPluginTheSourceFolderDoesNotHold_RefusesTheMod_LeavingItsPluginSource()
    {
        await InitializedWithALocalizedPlugin();
        var before = SourceFilesOf(Plugin);

        var refused = Assert.Single((await Build(new ModToBuild(ModName, SourceFolder, ModFolder, new BuildStep.Decompile([Plugin])))).Refused);

        Assert.Equal((BuildRefusal.NotDecompiled, $"'{SourceFolder}' holds no '{Plugin}' to decompile."), (refused.Refusal, refused.Message));
        Assert.Equal(before, SourceFilesOf(Plugin));
    }

    private string[] SourceFilesOf(string plugin) =>
        [.. Directory.GetFiles(Path.Combine(SourceFolder, "plugin-source", plugin), "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal)];

    private async Task InitializedWithALocalizedPlugin()
    {
        var plugin = Path.Combine(Directory.CreateDirectory(ModFolder).FullName, Plugin);
        var written = new Fallout4Mod(ModKey.FromFileName(Plugin), Fallout4Release.Fallout4);
        written.Doors.AddNew("FixtureDoor").Name = new TranslatedString(Language.English, "The Big Door");
        written.UsingLocalization = true;
        written.WriteToBinary(plugin);
        var provider = new PluginProvider.FromMod(ModName, ModFolder, SourceFolder);
        _holder.Apply(SnapshotPlugins.Snapshot(Directory.CreateDirectory(Path.Combine(_root, "Data")).FullName, _root, GameRelease.Fallout4,
            [new LoadOrderEntry(Plugin, plugin, ModName, 0, Enabled: true, Winning: true, NamedProvider: provider)]));
        Assert.Single((await TestEditService.DecompileAndCommitModHandler(_holder).DecompileAndCommitAsync([new ModToDecompileAndCommit(ModName, ModFolder, new NewRepository(SourceFolder, [], SourceInits.BuildFile))])).Value().Applied);
    }

    private ModToBuild Copy(params string[] paths) => new(ModName, SourceFolder, ModFolder, new BuildStep.Copy(paths));

    private ModToBuild Compile() => new(ModName, SourceFolder, ModFolder, new BuildStep.Compile([Plugin]));

    private ModToBuild Pack(params ArchiveToPack[] archives) => new(ModName, SourceFolder, ModFolder, new BuildStep.Pack(archives));

    private async Task<ModBuilt> Landed(ModToBuild mod, InstanceToBuild? instance = null)
    {
        var result = await Build(mod, instance);
        Assert.Empty(result.Refused);
        return Assert.Single(result.Applied);
    }

    private async Task<BuildResult> Build(ModToBuild mod, InstanceToBuild? instance = null)
    {
        if (_holder.Held is null) _holder.Apply(SnapshotPlugins.Snapshot(_root, _root, GameRelease.Fallout4, []));
        return (await TestEditService.BuildModHandler(_holder).BuildAsync([mod], instance ?? NoArchives)).Value();
    }

    private static readonly InstanceToBuild Packing = new(ExclusionMark, new ArchiveVariants(
        new Ba2Variant(1, Ba2Contents.General, Compressed: false), new Ba2Variant(1, Ba2Contents.Textures, Compressed: false)));

    private void WriteSource(params (string Path, string Text)[] files)
    {
        Directory.CreateDirectory(SourceFolder);
        foreach (var (path, text) in files) Write(SourceFolder, path, Encoding.UTF8.GetBytes(text));
    }

    private string Shared()
    {
        GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "init", "-q", "-b", "main");
        GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "remote", "add", "origin", Remote);
        GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "add", "-A");
        GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "commit", "-q", "-m", "Source");
        return GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "rev-parse", "HEAD").Trim();
    }

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
