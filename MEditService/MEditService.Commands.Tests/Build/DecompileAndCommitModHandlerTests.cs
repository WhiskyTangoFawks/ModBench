using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
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

        Assert.StartsWith(
            "{\n\"output\": \"FixtureMod\",",
            GitProbe.Run(Path.Combine(SourceFolder, ".git"), SourceFolder, "show", $"main:{Origin}.manifest.json"), StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(_mod.Folder, $"{Origin}.manifest.json")));
    }

    [Fact]
    public async Task Init_OfAModWithAnInstallationFile_CommitsAsAssetsOnlyTheFilesItDoesNotYield_AndItsManifestNamesTheFileAndWhatItYields()
    {
        WriteInModFolder("textures/a.dds", "from the pack");
        WriteInModFolder("Scripts/Quest.pex", "mine");
        var installationFile = PackHolding(("textures/a.dds", "from the pack"));

        await InitWith(new ModToDecompileAndCommit(Origin, SourceFolder, [], installationFile));

        Assert.Equal(["assets/Scripts/Quest.pex"], CommittedAssets());
        var manifest = CommittedManifest();
        Assert.Equal(Origin, manifest.Output);
        Assert.Equal(
            [new ManifestPackage.SourceRepository(Origin, IsSubmodule: false),
             new ManifestPackage.InstallationFile(DownloadedZip.PackName, installationFile.Size, installationFile.Hash)],
            manifest.Packages);
        Assert.Equal(
            [new ManifestFile("Fixture.esp", new PackageEntry.Held()), new ManifestFile("Scripts/Quest.pex", new PackageEntry.Held()),
             new ManifestFile("textures/a.dds", new PackageEntry.Held(), DownloadedZip.PackName)],
            manifest.Files);
    }

    [Fact]
    public async Task Init_OfAFileTheInstallationFileHoldsWithOtherBytes_CommitsItAsAnAsset()
    {
        WriteInModFolder("textures/a.dds", "edited");
        var installationFile = PackHolding(("textures/a.dds", "from the pack"));

        await InitWith(new ModToDecompileAndCommit(Origin, SourceFolder, [], installationFile));

        Assert.Equal(["assets/textures/a.dds"], CommittedAssets());
        Assert.DoesNotContain(CommittedManifest().Files, file => file.Package is not null);
    }

    [Fact]
    public async Task Init_OfAModWhoseManifestHoldsSteps_CarriesThemAndTheFilesTheyMake_AndTheVersionTheMetadataSays()
    {
        WriteInModFolder("textures/a.dds", "from the pack");
        WriteInModFolder("textures/made.dds", "made");
        WriteInModFolder(
            $"{Origin}.manifest.json",
            "{\"packages\": [{\"installationFile\":\"Pack.zip\",\"size\":1,\"hash\":\"HASH\",\"version\":\"1.0\"}], "
            + "\"steps\": [{\"task\": \"make\", \"args\": [\"x\"]}], \"files\": [{\"path\": \"textures/made.dds\", \"madeByStep\": true}]}");

        await InitWith(new ModToDecompileAndCommit(Origin, SourceFolder, [], PackHolding(("textures/a.dds", "from the pack")), "2.0"));

        var manifest = CommittedManifest();
        var step = Assert.Single(manifest.Steps);
        Assert.Equal("make", step.Task);
        Assert.Equal(["x"], step.Args);
        Assert.Equal(
            [new ManifestFile("Fixture.esp", new PackageEntry.Held()), new ManifestFile("textures/a.dds", new PackageEntry.Held(), DownloadedZip.PackName),
             new ManifestFile("textures/made.dds", new PackageEntry.MadeByStep())],
            manifest.Files);
        Assert.Equal("2.0", manifest.Version);
        Assert.Empty(CommittedAssets());
    }

    [Fact]
    public async Task Init_ThenABuild_LeavesTheManifestsTextUnchanged()
    {
        WriteInModFolder("textures/a.dds", "from the pack");
        WriteInModFolder("Scripts/Quest.pex", "mine");
        var installationFile = PackHolding(("textures/a.dds", "from the pack"));
        await InitWith(new ModToDecompileAndCommit(Origin, SourceFolder, [], installationFile, "1.0"));
        var manifestFile = Path.Combine(SourceFolder, $"{Origin}.manifest.json");
        var written = File.ReadAllText(manifestFile);

        var built = await TestEditService.BuildModHandler(_holder).BuildAsync(
            [new ModToBuild(Origin, SourceFolder, _mod.Folder, [], "1.0", IsSubmodule: false) { InstallationFiles = [installationFile] }],
            new InstanceToBuild(".excluded", Archives: null, Path.Combine(_instanceRoot, "stat-cache")));

        Assert.Single(built.Value().Applied);
        Assert.Equal(written, File.ReadAllText(manifestFile));
    }

    [Fact]
    public async Task Init_OfAModWhoseManifestNamesTheGameFolder_KeepsItsPackageAndLines_AndCommitsNoAssetForTheGameFile()
    {
        WriteInModFolder("textures/a.dds", "from the game");
        WriteInModFolder("Scripts/Quest.pex", "mine");
        WriteInModFolder(
            $"{Origin}.manifest.json", "{\"packages\": [{\"gameFolder\":\"Fallout 4\",\"hash\":\"AAAAAAAAAAA=\"}], \"files\": [{\"path\": \"textures/a.dds\"}]}");

        var result = await InitWith(new ModToDecompileAndCommit(Origin, SourceFolder, [], GameFolder: GameFolderOnDisk.Holding(_instanceRoot, "game", ("textures/a.dds", "from the game"))));

        Assert.Empty(result.Refused);
        var manifest = CommittedManifest();
        Assert.Equal("Fallout 4", Assert.IsType<ManifestPackage.GameFolder>(manifest.Packages[1]).Name);
        Assert.Equal(new ManifestFile("textures/a.dds", new PackageEntry.Held(), "Fallout 4"), manifest.Files.Single(line => line.Path == "textures/a.dds"));
        Assert.Equal(["assets/Scripts/Quest.pex"], CommittedAssets());
    }

    [Fact]
    public async Task Init_OfAModWhoseManifestNamesTheGameFolder_WhenTheRequestFoundNone_RefusesTheMod_LeavingNoRepositoryAndTheManifestInPlace()
    {
        WriteInModFolder("textures/a.dds", "from the game");
        WriteInModFolder(
            $"{Origin}.manifest.json", "{\"packages\": [{\"gameFolder\":\"Fallout 4\",\"hash\":\"AAAAAAAAAAA=\"}], \"files\": [{\"path\": \"textures/a.dds\"}]}");

        var refused = Assert.Single((await InitWith(new ModToDecompileAndCommit(Origin, SourceFolder, []))).Refused);

        Assert.Equal(DecompileAndCommitRefusal.GameFolderNotFound, refused.Refusal);
        Assert.False(Directory.Exists(SourceFolder));
        Assert.True(File.Exists(Path.Combine(_mod.Folder, $"{Origin}.manifest.json")));
    }

    [Fact]
    public async Task Init_OfAModWhoseManifestCannotBeRead_RefusesTheMod_LeavingNoRepositoryAndTheManifestInPlace()
    {
        WriteInModFolder($"{Origin}.manifest.json", "not a manifest");

        var refused = Assert.Single((await InitWith(new ModToDecompileAndCommit(Origin, SourceFolder, []))).Refused);

        Assert.Equal(DecompileAndCommitRefusal.ModFilesUnreadable, refused.Refusal);
        Assert.False(Directory.Exists(SourceFolder));
        Assert.True(File.Exists(Path.Combine(_mod.Folder, $"{Origin}.manifest.json")));
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

    private InstallationFile PackHolding(params (string Path, string Text)[] entries)
    {
        var downloaded = DownloadedZip.WritePack(Path.Combine(_instanceRoot, "downloads"), entries);
        var pack = Directory.CreateDirectory(Path.Combine(_instanceRoot, "unpacked")).FullName;
        foreach (var (path, text) in entries)
        {
            var file = Path.Combine(pack, path);
            Directory.CreateDirectory(Path.GetDirectoryName(file).Require());
            File.WriteAllText(file, text);
        }
        var hashes = new ModFolderRepository(TimeProvider.System).Files(pack, new HashSet<string>(), null).Files.ToDictionary(file => file.Path, file => file.Hash);
        return downloaded with { Entries = [.. entries.Select(entry => new HashedEntry(entry.Path, hashes[entry.Path]))] };
    }

    private Manifest CommittedManifest() =>
        new ModFolderRepository(TimeProvider.System).ReadSourceManifest(SourceFolder).Holds(out var manifest, out var why) && manifest is not null
            ? manifest
            : throw new InvalidOperationException(why);

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
