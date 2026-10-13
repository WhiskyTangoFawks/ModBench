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

public sealed class InitHandlerTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string Origin = "FixtureMod";

    private readonly ScratchDirectory _instanceRoot = new("medit-init-handler-");
    private readonly LoadOrderHolder _holder = new();
    private readonly PluginProvider.FromMod _mod;

    public InitHandlerTests()
    {
        _mod = new PluginProvider.FromMod(
            Origin,
            Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName,
            SourceFolder);
        var gameDirectory = Directory.CreateDirectory(Path.Combine(_instanceRoot, "game")).FullName;

        var pluginPath = Path.Combine(_mod.Folder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("FixtureNpc");
        mod.WriteToBinary(pluginPath);

        Snapshot = SnapshotPlugins.Snapshot(gameDirectory, _instanceRoot, GameRelease.Fallout4,
            [new LoadOrderEntry(PluginName, pluginPath, Origin, 0, Enabled: true, Winning: true, NamedProvider: _mod)]);
    }

    private LoadOrderSnapshot Snapshot { get; }

    private string SourceFolder => Path.Combine(_instanceRoot, "source", Origin);

    public void Dispose() => _instanceRoot.Dispose();

    [Fact]
    public async Task Init_OverTheHeldLoadOrder_PutsThePluginsSourceInItsSourceFolder_AndWritesNothingInItsModFolder()
    {
        _holder.Apply(Snapshot);
        var handler = TestEditService.InitHandler(_holder);
        var modFolderBefore = TreeSnapshot.Of(_mod.Folder);

        var result = await handler.InitAsync(ToInit.In(Snapshot, Origin));

        Assert.Equal([new PluginAddress(PluginName, Origin)], Assert.Single(result.Landed).Outcome.Plugins);
        Assert.True(TestAdapters.Source().SourceReads(new RegisteredPlugin(PluginName, Origin, "", _mod, Line: null, PluginStrings.None)));
        Assert.Equal(modFolderBefore, TreeSnapshot.Of(_mod.Folder));
    }

    [Fact]
    public async Task Init_OverAModTwiceUnderDifferentCasing_InitsItOnce_AndRefusesTheModThatProvidesNothingOnItsOwn()
    {
        _holder.Apply(Snapshot);
        var handler = TestEditService.InitHandler(_holder);

        var result = await handler.InitAsync(ToInit.In(Snapshot, Origin, "NoSuchMod", Origin.ToUpperInvariant()));

        Assert.Equal([Origin], result.Landed.Select(landed => landed.Item));
        var refused = Assert.Single(result.Refused);
        Assert.Equal(("NoSuchMod", InitRefusal.ModProvidesNoPlugin), (refused.Item, refused.Refusal));
        Assert.Null(result.SelectionRefusal);
    }

    [Fact]
    public async Task Init_TakesTheFilesNoInstallationFileYields_AsTheAssets()
    {
        WriteInModFolder("textures/kept.dds", "as installed");
        WriteInModFolder("textures/edited.dds", "edited after install");
        WriteInModFolder("meshes/added.nif", "added after install");
        var installed = InstallationFileHolding(("textures/kept.dds", "as installed"), ("textures/edited.dds", "as installed, before the edit"));

        var result = await InitWith(new ModToInit(Origin, SourceFolder, [installed], []));

        Assert.Single(result.Landed);
        Assert.Equal(["assets/meshes/added.nif", "assets/textures/edited.dds"], CommittedAssets());
        Assert.Equal("edited after install", File.ReadAllText(Path.Combine(SourceFolder, "assets", "textures", "edited.dds")));
    }

    [Fact]
    public async Task Init_TakesAFileAnInstallationFileYieldsFromAnotherPathInIt_AsYielded()
    {
        WriteInModFolder("textures/chosen.dds", "an option the installer chose");
        var installed = InstallationFileHolding(("00 Core/textures/chosen.dds", "an option the installer chose"));

        var result = await InitWith(new ModToInit(Origin, SourceFolder, [installed], []));

        Assert.Single(result.Landed);
        Assert.Empty(CommittedAssets());
    }

    [Fact]
    public async Task Init_OfAModWithNoInstallationFile_TakesEveryFileAsAnAsset_ButWhatCompileWritesAndTheModManagersFiles()
    {
        WriteInModFolder("meta.ini", "[General]");
        WriteInModFolder("Scripts/Quest.pex", "a script");

        await InitWith(new ModToInit(Origin, SourceFolder, [], ["meta.ini"]));

        Assert.Equal(["assets/Scripts/Quest.pex"], CommittedAssets());
    }

    [PosixFact]
    public async Task Init_OfAModWithAFileThatCannotBeRead_RefusesTheMod_LeavingNoRepository()
    {
        WriteInModFolder("textures/held.dds", "held");
        var held = Path.Combine(_mod.Folder, "textures", "held.dds");
        FileModes.Set(held, "000");
        try
        {
            var result = await InitWith(new ModToInit(Origin, SourceFolder, [], []));

            var refused = Assert.Single(result.Refused);
            Assert.Equal(InitRefusal.ModFilesUnreadable, refused.Refusal);
            Assert.Contains("held.dds", refused.Message, StringComparison.Ordinal);
            Assert.False(Directory.Exists(SourceFolder));
        }
        finally
        {
            FileModes.Set(held, "600");
        }
    }

    private Task<SelectionResult<string, InitRefusal, InitializedMod>> InitWith(ModToInit mod)
    {
        _holder.Apply(Snapshot);
        return TestEditService.InitHandler(_holder).InitAsync([mod]);
    }

    private void WriteInModFolder(string path, string text)
    {
        var file = Path.Combine(_mod.Folder, path);
        Directory.CreateDirectory(Path.GetDirectoryName(file).Require());
        File.WriteAllText(file, text);
    }

    private InstallationFile InstallationFileHolding(params (string Path, string Text)[] entries)
    {
        var extracted = Directory.CreateDirectory(Path.Combine(_instanceRoot, "extracted")).FullName;
        foreach (var (path, text) in entries)
        {
            var file = Path.Combine(extracted, path);
            Directory.CreateDirectory(Path.GetDirectoryName(file).Require());
            File.WriteAllText(file, text);
        }
        var hashedAsAModsFiles = new ModFolderRepository(TimeProvider.System).Files(extracted, "installed", new HashSet<string>());
        return new InstallationFile(
            Path.Combine(_instanceRoot, "downloads", "installed.7z"), Source: null, Size: 1, Hash: "AAAAAAAAAAA=",
            [.. hashedAsAModsFiles.Select(entry => new HashedEntry(entry.Path, entry.Hash))]);
    }

    private string[] CommittedAssets() =>
        [.. GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "ls-tree", "-r", "--name-only", "main")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Where(path => path.StartsWith("assets/", StringComparison.Ordinal))];
}
