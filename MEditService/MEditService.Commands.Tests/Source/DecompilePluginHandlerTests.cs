using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Source;

public sealed class DecompilePluginHandlerTests : IDisposable
{
    private const string SourceModName = "SourceMod";
    private const string NonSourceModName = "NonSourceMod";
    private readonly ScratchDirectory _root = new("medit-decompile-");
    private readonly string _sourceMod;
    private readonly string _nonSourceMod;
    private readonly LoadOrderHolder _holder = new();

    public DecompilePluginHandlerTests()
    {
        _sourceMod = Directory.CreateDirectory(Path.Combine(_root, "mods", SourceModName)).FullName;
        _nonSourceMod = Directory.CreateDirectory(Path.Combine(_root, "mods", NonSourceModName)).FullName;
        WritePlugin(_sourceMod, "First.esp", "FirstNpc");
        WritePlugin(_nonSourceMod, "Other.esp", "OtherNpc");
        var dataFolder = Directory.CreateDirectory(Path.Combine(_root, "Data")).FullName;
        WritePlugin(dataFolder, "Vanilla.esp", "VanillaNpc");
        _holder.Apply(SnapshotPlugins.Snapshot(dataFolder, _root, GameRelease.Fallout4,
        [
            new LoadOrderEntry("First.esp", Path.Combine(_sourceMod, "First.esp"), SourceModName, 0, Enabled: true, Winning: true),
            new LoadOrderEntry("Other.esp", Path.Combine(_nonSourceMod, "Other.esp"), NonSourceModName, 2, Enabled: true, Winning: true),
        ]));
        var committed = TestEditService.DecompileAndCommitModHandler(_holder)
            .DecompileAndCommitAsync(ToDecompileAndCommit.In(_holder.Held?.Snapshot, SourceModName))
            .GetAwaiter().GetResult().Value();
        Assert.Equal([CompiledPlugin("First.esp")], Assert.Single(committed.Applied).Plugins);
        WritePlugin(_sourceMod, "Second.esp", "SecondNpc");
        _holder.Apply(SnapshotPlugins.Snapshot(dataFolder, _root, GameRelease.Fallout4,
        [
            new LoadOrderEntry("First.esp", Path.Combine(_sourceMod, "First.esp"), SourceModName, 0, Enabled: true, Winning: true),
            new LoadOrderEntry("Second.esp", Path.Combine(_sourceMod, "Second.esp"), SourceModName, 1, Enabled: true, Winning: true),
            new LoadOrderEntry("Other.esp", Path.Combine(_nonSourceMod, "Other.esp"), NonSourceModName, 2, Enabled: true, Winning: true),
            new LoadOrderEntry("Vanilla.esp", Path.Combine(_root, "Data", "Vanilla.esp"), PluginOrigin.DataDirectory, 3, Enabled: true, Winning: true),
        ]));
    }

    public void Dispose() => _root.Dispose();

    private string Head() =>
        GitProbe.Run(Path.Combine(_sourceMod, ".git"), _sourceMod, "rev-parse", "HEAD").Trim();

    [Fact]
    public async Task Decompile_OfANonCompiledPluginInASourceMod_WritesItsSourceToTheWorkingTree_AndCommitsNothing()
    {
        var headBefore = Head();
        Assert.NotEmpty(headBefore);

        var result = await Decompile(CompiledPlugin("Second.esp"));

        Assert.Equal([CompiledPlugin("Second.esp")], result.Applied);
        Assert.Empty(result.Refused);
        Assert.Contains("SecondNpc", SourceTextOf("Second.esp"), StringComparison.Ordinal);
        Assert.Equal(headBefore, Head());
    }

    [Fact]
    public async Task Decompile_ParksThePluginsBytes_SoItReadsAsOneModbenchWrote()
    {
        await Decompile(CompiledPlugin("Second.esp"));

        Assert.Empty(ExternalChanges.NamedBy(_holder.Current));
    }

    [Fact]
    public async Task Decompile_ParksTheHashOfTheBytesItsSourceWasReadFrom()
    {
        await Decompile(new ReadingAs("READ-FROM"), CompiledPlugin("Second.esp"));

        Assert.Equal(
            ["READ-FROM"],
            TestAdapters.Source().OverFolder(new PluginProvider.FromMod(SourceModName, _sourceMod, _sourceMod), GameRelease.Fallout4).LastWrittenBinarySha256s(CompiledPlugin("Second.esp")).Value());
    }

    [Fact]
    public async Task Decompile_OfACompiledPlugin_ReplacesItsSourceInTheWorkingTree_WithWhatItsBytesHold_DiscardingHandEditsAndStrayDocuments()
    {
        var first = TreeDocuments.Of(Repository, CompiledPlugin("First.esp")).Single(document => document.EditorId == "FirstNpc");
        var identity = new RecordIdentity(first.FormKey, first.RecordType, first.EditorId);
        var stray = TreeTampering.Stray(_sourceMod, CompiledPlugin("First.esp"), identity, "Stray.json", "{}");
        SourceModTree.Overwrite(
            _sourceMod, CompiledPlugin("First.esp"), identity, first.Body.Replace("FirstNpc", "EditedByHand", StringComparison.Ordinal));
        WritePlugin(_sourceMod, "First.esp", "UpgradedNpc");

        var result = await Decompile(force: true, CompiledPlugin("First.esp"));

        Assert.Equal([CompiledPlugin("First.esp")], result.Applied);
        Assert.False(File.Exists(stray));
        var text = SourceTextOf("First.esp");
        Assert.Contains("UpgradedNpc", text, StringComparison.Ordinal);
        Assert.DoesNotContain("EditedByHand", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Decompile_OfAPluginWhoseSourceHasWorkingTreeChanges_RefusesItNamingEachChangedFile_AndWritesNothing()
    {
        var first = TreeDocuments.Of(Repository, CompiledPlugin("First.esp")).Single(document => document.EditorId == "FirstNpc");
        var identity = new RecordIdentity(first.FormKey, first.RecordType, first.EditorId);
        var stray = TreeTampering.Stray(_sourceMod, CompiledPlugin("First.esp"), identity, "Stray.json", "{}");
        SourceModTree.Overwrite(
            _sourceMod, CompiledPlugin("First.esp"), identity, first.Body.Replace("FirstNpc", "EditedByHand", StringComparison.Ordinal));
        WritePlugin(_sourceMod, "First.esp", "UpgradedNpc");

        var result = await Decompile(CompiledPlugin("First.esp"));

        Assert.Empty(result.Applied);
        var refused = Assert.Single(result.Refused);
        Assert.Equal(DecompileRefusal.WorkingTreeChanges, refused.Refusal);
        Assert.Contains("Stray.json", refused.Message, StringComparison.Ordinal);
        Assert.Contains("FirstNpc", refused.Message, StringComparison.Ordinal);
        Assert.Contains("force", refused.Message, StringComparison.Ordinal);
        Assert.True(File.Exists(stray));
    }

    [Fact]
    public async Task Decompile_OfAPluginWhoseWorkingTreeStatusCannotBeRead_RefusesItAsUnreadable_AndWritesNothing()
    {
        var before = SourceTextOf("First.esp");
        File.WriteAllText(Path.Combine(_sourceMod, ".git", "HEAD"), "not a ref");
        WritePlugin(_sourceMod, "First.esp", "UpgradedNpc");

        var result = await Decompile(CompiledPlugin("First.esp"));

        Assert.Empty(result.Applied);
        Assert.Equal(DecompileRefusal.WorkingTreeStatusUnreadable, Assert.Single(result.Refused).Refusal);
        Assert.Equal(before, SourceTextOf("First.esp"));
    }

    [Fact]
    public async Task Decompile_OfASelection_RefusesOnlyThePluginWhoseSourceHasWorkingTreeChanges()
    {
        var first = TreeDocuments.Of(Repository, CompiledPlugin("First.esp")).Single(document => document.EditorId == "FirstNpc");
        SourceModTree.Overwrite(
            _sourceMod, CompiledPlugin("First.esp"), new RecordIdentity(first.FormKey, first.RecordType, first.EditorId),
            first.Body.Replace("FirstNpc", "EditedByHand", StringComparison.Ordinal));

        var result = await Decompile(CompiledPlugin("First.esp"), CompiledPlugin("Second.esp"));

        Assert.Equal([CompiledPlugin("Second.esp")], result.Applied);
        Assert.Equal(CompiledPlugin("First.esp"), Assert.Single(result.Refused).Item);
    }

    [Fact]
    public async Task Decompile_OfAPluginInAModWithNoRepository_RefusesIt_AndWritesNothing()
    {
        var result = await Decompile(new PluginAddress("Other.esp", NonSourceModName));

        Assert.Empty(result.Applied);
        var refused = Assert.Single(result.Refused);
        Assert.Equal(DecompileRefusal.NotInSourceMod, refused.Refusal);
        Assert.Contains("Other.esp", refused.Message, StringComparison.Ordinal);
        Assert.Contains($"decompile and commit on {NonSourceModName}", refused.Message, StringComparison.Ordinal);
        Assert.False(TestAdapters.Source().SourceReads(new RegisteredPlugin("Other.esp", NonSourceModName, "", new PluginProvider.FromMod(NonSourceModName, _nonSourceMod, _nonSourceMod), Line: null, PluginStrings.None)));
    }

    [Fact]
    public async Task Decompile_OfAPluginFromNoMod_RefusesItAsFromNoMod_AndWritesNothing()
    {
        var result = await Decompile(new PluginAddress("Vanilla.esp", PluginOrigin.DataDirectory));

        Assert.Empty(result.Applied);
        var refused = Assert.Single(result.Refused);
        Assert.Equal(DecompileRefusal.NotFromAMod, refused.Refusal);
        Assert.Contains("Vanilla.esp", refused.Message, StringComparison.Ordinal);
    }

    [PosixFact]
    public async Task Decompile_OfAPluginWhoseSourceHasTwinFoldersNeitherSpelledAsTheLoadOrderNamesIt_IsRefusedAsAmbiguousSource()
    {
        var sources = Path.Combine(_sourceMod, "plugin-source");
        Directory.Move(Path.Combine(sources, "First.esp"), Path.Combine(sources, "FIRST.ESP"));
        Directory.CreateDirectory(Path.Combine(sources, "first.esp"));

        var result = await Decompile(force: true, CompiledPlugin("First.esp"));

        Assert.Equal(DecompileRefusal.AmbiguousSource, Assert.Single(result.Refused).Refusal);
    }

    [Fact]
    public async Task Decompile_OfASelection_LandsEachPluginOnItsOwn_ANotLoadedOneRefusedByName()
    {
        var result = await Decompile(new PluginAddress("NoSuch.esp", SourceModName), CompiledPlugin("Second.esp"));

        Assert.Equal([CompiledPlugin("Second.esp")], result.Applied);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((new PluginAddress("NoSuch.esp", SourceModName), DecompileRefusal.PluginNotLoaded), (refused.Item, refused.Refusal));
    }

    [Fact]
    public async Task Decompile_OfASelectionNamingAPluginTwice_LandsItOnce()
    {
        var spelledAgain = new PluginAddress("SECOND.ESP", SourceModName);

        var result = await Decompile(CompiledPlugin("Second.esp"), spelledAgain);

        Assert.Empty(result.Refused);
        Assert.Equal([CompiledPlugin("Second.esp")], result.Applied);
    }

    [Fact]
    public async Task Decompile_OfAPluginThatFailsItsRoundTripGate_RefusesIt_AndLeavesItsSourceAsItWas()
    {
        var before = SourceTextOf("First.esp");
        WritePlugin(_sourceMod, "First.esp", "UpgradedNpc");

        var result = await Decompile(new ForgedTreeWriteAdapter(DeserializeThenCorruptTheNpc), CompiledPlugin("First.esp"));

        var refused = Assert.Single(result.Refused);
        Assert.Equal(DecompileRefusal.RoundTripFailed, refused.Refusal);
        Assert.Equal(before, SourceTextOf("First.esp"));
    }

    private static async Task<IMod> DeserializeThenCorruptTheNpc(string folder, CancellationToken cancel)
    {
        var deserialized = await Fallout4WholeMod.Deserialize(folder, cancel);
        deserialized.Npcs.First().EditorID += "Corrupted";
        return deserialized;
    }

    private static PluginAddress CompiledPlugin(string plugin) => new(plugin, SourceModName);

    private Task<DecompileResult> Decompile(params PluginAddress[] plugins) =>
        Decompile(force: false, plugins);

    private async Task<DecompileResult> Decompile(bool force, params PluginAddress[] plugins) =>
        (await TestEditService.DecompileHandler(_holder).DecompileAsync(plugins, force)).Value();

    private async Task<DecompileResult> Decompile(IPluginAdapter adapter, params PluginAddress[] plugins) =>
        (await TestEditService.DecompileHandler(_holder, adapter).DecompileAsync(plugins, force: false)).Value();

    private static void WritePlugin(string modFolder, string name, string editorId)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        mod.WriteToBinary(Path.Combine(modFolder, name));
    }

    private ISourceRepository Repository => TestAdapters.Source().Open(new PluginProvider.FromMod(SourceModName, _sourceMod, _sourceMod), GameRelease.Fallout4).Require();

    private string SourceTextOf(string plugin) => string.Concat(
        TreeDocuments.Of(Repository, CompiledPlugin(plugin)).Select(document => document.Body).Order(StringComparer.Ordinal));
}
