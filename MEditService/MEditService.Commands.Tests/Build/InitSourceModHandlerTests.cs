using System.Text;
using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Build;

public sealed class InitSourceModHandlerTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string Origin = "FixtureMod";

    private readonly ScratchDirectory _instanceRoot = new("medit-init-handler-");
    private readonly LoadOrderHolder _holder = new();
    private readonly PluginProvider.FromMod _mod;

    public InitSourceModHandlerTests()
    {
        _mod = new PluginProvider.FromMod(
            Origin,
            Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName,
            SourceFolder);
        var dataFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "Data")).FullName;

        var pluginPath = Path.Combine(_mod.Folder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("FixtureNpc");
        mod.WriteToBinary(pluginPath);

        Snapshot = SnapshotPlugins.Snapshot(dataFolder, _instanceRoot, GameRelease.Fallout4,
            [new LoadOrderEntry(PluginName, pluginPath, Origin, 0, Enabled: true, Winning: true, NamedProvider: _mod)]);
    }

    private LoadOrderSnapshot Snapshot { get; }

    private string SourceFolder => Path.Combine(_instanceRoot, "source", Origin);

    public void Dispose() => _instanceRoot.Dispose();

    [Fact]
    public async Task Init_OverTheHeldLoadOrder_PutsThePluginsSourceInItsSourceFolder_AndWritesNothingInItsModFolder()
    {
        _holder.Apply(Snapshot);
        var handler = TestEditService.InitSourceModHandler(_holder);
        var modFolderBefore = TreeSnapshot.Of(_mod.Folder);

        var result = (await handler.InitSourceModAsync(ToInitSourceMod.In(Snapshot, Origin))).Value();

        Assert.Equal([new PluginAddress(PluginName, Origin)], Assert.Single(result.Applied).Plugins);
        Assert.True(TestAdapters.Source().SourceReads(new RegisteredPlugin(PluginName, Origin, "", _mod, Line: null, PluginStrings.None)));
        Assert.Equal(modFolderBefore, TreeSnapshot.Of(_mod.Folder));
    }

    [Fact]
    public async Task Init_OverAModTwiceUnderDifferentCasing_InitsItOnce()
    {
        _holder.Apply(Snapshot);
        var handler = TestEditService.InitSourceModHandler(_holder);

        var result = (await handler.InitSourceModAsync(ToInitSourceMod.In(Snapshot, Origin, Origin.ToUpperInvariant()))).Value();

        Assert.Equal([Origin], result.Applied.Select(mod => mod.Mod));
        Assert.Empty(result.Refused);
    }

    [Fact]
    public async Task Init_OfAModThatProvidesNoPlugin_MakesItASourceModOfItsAssets()
    {
        var settings = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", "Settings")).FullName;
        File.WriteAllText(Path.Combine(settings, "Settings.ini"), "[General]");
        var sourceFolder = Path.Combine(_instanceRoot, "source", "Settings");

        var result = await InitWith(new ModToInitSourceMod("Settings", settings, new NewRepository(sourceFolder, ["Settings.ini"], SourceInits.BuildFile)));

        Assert.Empty(Assert.Single(result.Applied).Plugins);
        Assert.Equal("[General]", GitProbe.Run(Path.Combine(sourceFolder, ".git"), sourceFolder, "show", "main:Settings.ini"));
    }

    [Fact]
    public async Task Init_AskedNotToCommit_WritesTheSourceFolderAndCommitsNothing()
    {
        var result = await InitWith(new ModToInitSourceMod(Origin, _mod.Folder, new NewRepository(SourceFolder, [], SourceInits.BuildFile), Commit: false));

        Assert.Single(result.Applied);
        Assert.True(File.Exists(Path.Combine(SourceFolder, "build.json")));
        Assert.Equal(string.Empty, GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "for-each-ref", "refs/heads"));
    }

    [Fact]
    public async Task Init_CommitsTheAssetsItIsHanded_ReadFromTheModFolder_AndTheBuildFileItIsHanded_AsItsBytes()
    {
        WriteInModFolder("Scripts/Quest.pex", "a script");
        WriteInModFolder("textures/a.dds", "from the pack");
        WriteInModFolder($"{Origin}.manifest.json", "the mod folder's own");
        var modFolderBefore = TreeSnapshot.Of(_mod.Folder);

        Assert.Single((await InitWith(["Scripts/Quest.pex"], "{\"files\": []}")).Applied);

        Assert.Equal(["Scripts/Quest.pex"], CommittedAssets());
        Assert.Equal("{\"files\": []}", GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "show", "main:build.json"));
        Assert.Equal(modFolderBefore, TreeSnapshot.Of(_mod.Folder));
    }

    [PosixFact]
    public async Task Init_OfAnAssetThatCannotBeRead_RefusesTheMod_LeavingNoRepository()
    {
        WriteInModFolder("textures/held.dds", "held");
        var held = Path.Combine(_mod.Folder, "textures", "held.dds");
        FileModes.Set(held, "000");
        try
        {
            var refused = Assert.Single((await InitWith(["textures/held.dds"], "{}")).Refused);

            Assert.Equal(InitSourceModRefusal.CommitFailed, refused.Refusal);
            Assert.Contains("held.dds", refused.Message, StringComparison.Ordinal);
            Assert.False(Directory.Exists(Path.Combine(SourceFolder, ".git")));
        }
        finally
        {
            FileModes.Set(held, "600");
        }
    }

    private Task<InitSourceModResult> InitWith(IReadOnlyList<string> assets, string buildFile) =>
        InitWith(new ModToInitSourceMod(Origin, _mod.Folder, new NewRepository(SourceFolder, assets, Encoding.UTF8.GetBytes(buildFile))));

    private async Task<InitSourceModResult> InitWith(ModToInitSourceMod mod)
    {
        _holder.Apply(Snapshot);
        return (await TestEditService.InitSourceModHandler(_holder).InitSourceModAsync([mod])).Value();
    }

    private void WriteInModFolder(string path, string text)
    {
        var file = Path.Combine(_mod.Folder, path);
        Directory.CreateDirectory(Path.GetDirectoryName(file).Require());
        File.WriteAllText(file, text);
    }

    private string[] CommittedAssets() =>
        [.. GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "ls-tree", "-r", "--name-only", "main")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Where(path => path != ".gitignore" && path != "build.json" && !path.StartsWith("plugin-source/", StringComparison.Ordinal))];
}
