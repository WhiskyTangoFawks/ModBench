using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Build;

public sealed class DecompileAndCommitModHandlerTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string Origin = "FixtureMod";

    private readonly ScratchDirectory _instanceRoot = new("medit-init-handler-");
    private readonly LoadOrderHolder _holder = new();
    private readonly PluginProvider.FromMod _mod;

    public DecompileAndCommitModHandlerTests()
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
        var handler = TestEditService.DecompileAndCommitModHandler(_holder);
        var modFolderBefore = TreeSnapshot.Of(_mod.Folder);

        var result = (await handler.DecompileAndCommitAsync(ToDecompileAndCommit.In(Snapshot, Origin))).Value();

        Assert.Equal([new PluginAddress(PluginName, Origin)], Assert.Single(result.Applied).Plugins);
        Assert.True(TestAdapters.Source().SourceReads(new RegisteredPlugin(PluginName, Origin, "", _mod, Line: null, PluginStrings.None)));
        Assert.Equal(modFolderBefore, TreeSnapshot.Of(_mod.Folder));
    }

    [Fact]
    public async Task Init_OverAModTwiceUnderDifferentCasing_InitsItOnce_AndRefusesTheModThatProvidesNothingOnItsOwn()
    {
        _holder.Apply(Snapshot);
        var handler = TestEditService.DecompileAndCommitModHandler(_holder);

        var result = (await handler.DecompileAndCommitAsync(ToDecompileAndCommit.In(Snapshot, Origin, "NoSuchMod", Origin.ToUpperInvariant()))).Value();

        Assert.Equal([Origin], result.Applied.Select(mod => mod.Mod));
        var refused = Assert.Single(result.Refused);
        Assert.Equal(
            ("NoSuchMod", DecompileAndCommitRefusal.ModProvidesNoPlugin,
                "'NoSuchMod' provides no plugin in the load order, so there is nothing to decompile and commit."),
            (refused.Item, refused.Refusal, refused.Message));
    }

    [Fact]
    public async Task Init_TakesEveryFileAsAnAsset_ButWhatCompileWritesAndTheModManagersFiles()
    {
        WriteInModFolder("meta.ini", "[General]");
        WriteInModFolder("Scripts/Quest.pex", "a script");

        await InitWith(new ModToDecompileAndCommit(Origin, SourceFolder, ["meta.ini"]));

        Assert.Equal(["assets/Scripts/Quest.pex"], CommittedAssets());
    }

    [Fact]
    public async Task Init_CommitsAManifestNamingTheModsFolderAsItsOutput_InPlaceOfOneInTheModFolder()
    {
        WriteInModFolder($"{Origin}.manifest.json", "{\"files\": []}");

        Assert.Single((await InitWith(new ModToDecompileAndCommit(Origin, SourceFolder, []))).Applied);

        Assert.Equal(
            "{\n\"output\": \"FixtureMod\",\n\"files\": []\n}\n",
            GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "show", $"main:{Origin}.manifest.json"));
        Assert.False(File.Exists(Path.Combine(_mod.Folder, $"{Origin}.manifest.json")));
    }

    [PosixFact]
    public async Task Init_WhoseModFoldersManifestCannotBeRemoved_RefusesTheMod_LeavingNoRepositoryAndTheManifestInPlace()
    {
        WriteInModFolder($"{Origin}.manifest.json", "{\"files\": []}");
        FileModes.Set(_mod.Folder, "555");
        DecompileAndCommitResult result;
        try
        {
            result = await InitWith(new ModToDecompileAndCommit(Origin, SourceFolder, []));
        }
        finally
        {
            FileModes.Set(_mod.Folder, "755");
        }

        var refused = Assert.Single(result.Refused);
        Assert.Equal(DecompileAndCommitRefusal.CommitFailed, refused.Refusal);
        Assert.StartsWith($"'{Origin}' was not initialized: the manifest in its folder could not be removed: ", refused.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(Path.Combine(SourceFolder, ".git")));
        Assert.True(File.Exists(Path.Combine(_mod.Folder, $"{Origin}.manifest.json")));
    }

    [PosixFact]
    public async Task Init_OfAModWithAFileThatCannotBeRead_RefusesTheMod_LeavingNoRepository()
    {
        WriteInModFolder("textures/held.dds", "held");
        var held = Path.Combine(_mod.Folder, "textures", "held.dds");
        FileModes.Set(held, "000");
        try
        {
            var result = await InitWith(new ModToDecompileAndCommit(Origin, SourceFolder, []));

            var refused = Assert.Single(result.Refused);
            Assert.Equal(DecompileAndCommitRefusal.ModFilesUnreadable, refused.Refusal);
            Assert.Contains("held.dds", refused.Message, StringComparison.Ordinal);
            Assert.False(Directory.Exists(SourceFolder));
        }
        finally
        {
            FileModes.Set(held, "600");
        }
    }

    private async Task<DecompileAndCommitResult> InitWith(ModToDecompileAndCommit mod)
    {
        _holder.Apply(Snapshot);
        return (await TestEditService.DecompileAndCommitModHandler(_holder).DecompileAndCommitAsync([mod])).Value();
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
            .Where(path => path.StartsWith("assets/", StringComparison.Ordinal))];
}
