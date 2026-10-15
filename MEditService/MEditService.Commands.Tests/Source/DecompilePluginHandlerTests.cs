using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
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
    private const string TrackedModName = "TrackedMod";
    private const string UntrackedModName = "UntrackedMod";
    private readonly ScratchDirectory _root = new("medit-decompile-");
    private readonly string _trackedMod;
    private readonly string _untrackedMod;
    private readonly LoadOrderHolder _holder = new();

    public DecompilePluginHandlerTests()
    {
        _trackedMod = Directory.CreateDirectory(Path.Combine(_root, "mods", TrackedModName)).FullName;
        _untrackedMod = Directory.CreateDirectory(Path.Combine(_root, "mods", UntrackedModName)).FullName;
        WritePlugin(_trackedMod, "First.esp", "FirstNpc");
        WritePlugin(_untrackedMod, "Other.esp", "OtherNpc");
        var game = Directory.CreateDirectory(Path.Combine(_root, "game")).FullName;
        _holder.Apply(SnapshotPlugins.Snapshot(game, _root, GameRelease.Fallout4,
        [
            new LoadOrderEntry("First.esp", Path.Combine(_trackedMod, "First.esp"), TrackedModName, 0, Enabled: true, Winning: true),
            new LoadOrderEntry("Other.esp", Path.Combine(_untrackedMod, "Other.esp"), UntrackedModName, 2, Enabled: true, Winning: true),
        ]));
        var tracked = TestEditService.InitHandler(_holder)
            .InitAsync(ToInit.In(_holder.Held?.Snapshot, TrackedModName))
            .GetAwaiter().GetResult();
        Assert.Equal([Tracked("First.esp")], Assert.Single(tracked.Landed).Outcome.Plugins);
        WritePlugin(_trackedMod, "Second.esp", "SecondNpc");
        _holder.Apply(SnapshotPlugins.Snapshot(game, _root, GameRelease.Fallout4,
        [
            new LoadOrderEntry("First.esp", Path.Combine(_trackedMod, "First.esp"), TrackedModName, 0, Enabled: true, Winning: true),
            new LoadOrderEntry("Second.esp", Path.Combine(_trackedMod, "Second.esp"), TrackedModName, 1, Enabled: true, Winning: true),
            new LoadOrderEntry("Other.esp", Path.Combine(_untrackedMod, "Other.esp"), UntrackedModName, 2, Enabled: true, Winning: true),
        ]));
    }

    public void Dispose() => _root.Dispose();

    private string Head() =>
        GitProbe.Run(Path.Combine(_trackedMod, ".git"), _trackedMod, "rev-parse", "HEAD").Trim();

    [Fact]
    public async Task Decompile_OfAnUntrackedPluginInATrackedMod_WritesItsSourceToTheWorkingTree_AndCommitsNothing()
    {
        var headBefore = Head();
        Assert.NotEmpty(headBefore);

        var result = await Decompile(Tracked("Second.esp"));

        Assert.Equal([Tracked("Second.esp")], result.Landed.Select(landed => landed.Item));
        Assert.Empty(result.Refused);
        Assert.Contains("SecondNpc", SourceTextOf("Second.esp"), StringComparison.Ordinal);
        Assert.Equal(headBefore, Head());
    }

    [Fact]
    public async Task Decompile_ParksThePluginsBytes_SoItReadsAsOneModbenchWrote()
    {
        await Decompile(Tracked("Second.esp"));

        Assert.Empty(ExternalChanges.NamedBy(_holder.Current));
    }

    [Fact]
    public async Task Decompile_ParksTheHashOfTheBytesItsSourceWasReadFrom()
    {
        await Decompile(new ReadingAs("READ-FROM"), Tracked("Second.esp"));

        Assert.Equal(
            ["READ-FROM"],
            TestAdapters.Source().OverFolder(new PluginProvider.FromMod(TrackedModName, _trackedMod, _trackedMod), GameRelease.Fallout4).LastWrittenBinarySha256s(Tracked("Second.esp")).Value());
    }

    [Fact]
    public async Task Decompile_OfATrackedPlugin_ReplacesItsSourceInTheWorkingTree_WithWhatItsBytesHold_DiscardingHandEditsAndStrayDocuments()
    {
        var first = TreeDocuments.Of(Repository, Tracked("First.esp")).Single(document => document.EditorId == "FirstNpc");
        var identity = new RecordIdentity(first.FormKey, first.RecordType, first.EditorId);
        var stray = TreeTampering.Stray(_trackedMod, Tracked("First.esp"), identity, "Stray.json", "{}");
        TrackedTree.Overwrite(
            _trackedMod, Tracked("First.esp"), identity, first.Body.Replace("FirstNpc", "EditedByHand", StringComparison.Ordinal));
        WritePlugin(_trackedMod, "First.esp", "UpgradedNpc");

        var result = await Decompile(force: true, Tracked("First.esp"));

        Assert.Equal([Tracked("First.esp")], result.Landed.Select(landed => landed.Item));
        Assert.False(File.Exists(stray));
        var text = SourceTextOf("First.esp");
        Assert.Contains("UpgradedNpc", text, StringComparison.Ordinal);
        Assert.DoesNotContain("EditedByHand", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Decompile_OfAPluginWhoseSourceHasWorkingTreeChanges_RefusesItNamingEachChangedFile_AndWritesNothing()
    {
        var first = TreeDocuments.Of(Repository, Tracked("First.esp")).Single(document => document.EditorId == "FirstNpc");
        var identity = new RecordIdentity(first.FormKey, first.RecordType, first.EditorId);
        var stray = TreeTampering.Stray(_trackedMod, Tracked("First.esp"), identity, "Stray.json", "{}");
        TrackedTree.Overwrite(
            _trackedMod, Tracked("First.esp"), identity, first.Body.Replace("FirstNpc", "EditedByHand", StringComparison.Ordinal));
        WritePlugin(_trackedMod, "First.esp", "UpgradedNpc");

        var result = await Decompile(Tracked("First.esp"));

        Assert.Empty(result.Landed);
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
        File.WriteAllText(Path.Combine(_trackedMod, ".git", "HEAD"), "not a ref");
        WritePlugin(_trackedMod, "First.esp", "UpgradedNpc");

        var result = await Decompile(Tracked("First.esp"));

        Assert.Empty(result.Landed);
        Assert.Equal(DecompileRefusal.WorkingTreeStatusUnreadable, Assert.Single(result.Refused).Refusal);
        Assert.Equal(before, SourceTextOf("First.esp"));
    }

    [Fact]
    public async Task Decompile_OfASelection_RefusesOnlyThePluginWhoseSourceHasWorkingTreeChanges()
    {
        var first = TreeDocuments.Of(Repository, Tracked("First.esp")).Single(document => document.EditorId == "FirstNpc");
        TrackedTree.Overwrite(
            _trackedMod, Tracked("First.esp"), new RecordIdentity(first.FormKey, first.RecordType, first.EditorId),
            first.Body.Replace("FirstNpc", "EditedByHand", StringComparison.Ordinal));

        var result = await Decompile(Tracked("First.esp"), Tracked("Second.esp"));

        Assert.Equal([Tracked("Second.esp")], result.Landed.Select(landed => landed.Item));
        Assert.Equal(Tracked("First.esp"), Assert.Single(result.Refused).Item);
    }

    [Fact]
    public async Task Decompile_OfAPluginInAModWithNoRepository_RefusesIt_AndWritesNothing()
    {
        var result = await Decompile(new PluginAddress("Other.esp", UntrackedModName));

        Assert.Empty(result.Landed);
        var refused = Assert.Single(result.Refused);
        Assert.Equal(DecompileRefusal.NotInSourceMod, refused.Refusal);
        Assert.Contains("Other.esp", refused.Message, StringComparison.Ordinal);
        Assert.Contains("git init on the modlist", refused.Message, StringComparison.Ordinal);
        Assert.Contains("decompile and commit on the mod", refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("tracked", refused.Message, StringComparison.Ordinal);
        Assert.False(TestAdapters.Source().SourceReads(new RegisteredPlugin("Other.esp", UntrackedModName, "", new PluginProvider.FromMod(UntrackedModName, _untrackedMod, _untrackedMod), Line: null, PluginStrings.None)));
    }

    [PosixFact]
    public async Task Decompile_OfAPluginWhoseSourceHasTwinFoldersNeitherSpelledAsTheLoadOrderNamesIt_RefusesNamingBoth_AndWritesNoThirdFolder()
    {
        var sources = Path.Combine(_trackedMod, "plugin-source");
        Directory.Move(Path.Combine(sources, "First.esp"), Path.Combine(sources, "FIRST.ESP"));
        Directory.CreateDirectory(Path.Combine(sources, "first.esp"));

        var result = await Decompile(force: true, Tracked("First.esp"));

        var refused = Assert.Single(result.Refused);
        Assert.Equal(DecompileRefusal.AmbiguousSource, refused.Refusal);
        Assert.Contains("FIRST.ESP", refused.Message, StringComparison.Ordinal);
        Assert.Contains("first.esp", refused.Message, StringComparison.Ordinal);
        Assert.Equal(["FIRST.ESP", "first.esp"], Directory.GetDirectories(sources).Select(Path.GetFileName).Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Decompile_OfASelection_LandsEachPluginOnItsOwn_ANotLoadedOneRefusedByName()
    {
        var result = await Decompile(new PluginAddress("NoSuch.esp", TrackedModName), Tracked("Second.esp"));

        Assert.Equal([Tracked("Second.esp")], result.Landed.Select(landed => landed.Item));
        var refused = Assert.Single(result.Refused);
        Assert.Equal((new PluginAddress("NoSuch.esp", TrackedModName), DecompileRefusal.PluginNotLoaded), (refused.Item, refused.Refusal));
    }

    [Fact]
    public async Task Decompile_OfASelectionNamingAPluginTwice_LandsItOnce()
    {
        var spelledAgain = new PluginAddress("SECOND.ESP", TrackedModName);

        var result = await Decompile(Tracked("Second.esp"), spelledAgain);

        Assert.Empty(result.Refused);
        Assert.Equal([Tracked("Second.esp")], result.Landed.Select(landed => landed.Item));
    }

    [Fact]
    public async Task Decompile_OfAPluginThatFailsItsRoundTripGate_RefusesIt_AndLeavesItsSourceAsItWas()
    {
        var before = SourceTextOf("First.esp");
        WritePlugin(_trackedMod, "First.esp", "UpgradedNpc");

        var result = await Decompile(new ForgedTreeWriteAdapter(DeserializeThenCorruptTheNpc), Tracked("First.esp"));

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

    private static PluginAddress Tracked(string plugin) => new(plugin, TrackedModName);

    private Task<SelectionResult<PluginAddress, DecompileRefusal, NoOutcome>> Decompile(params PluginAddress[] plugins) =>
        Decompile(force: false, plugins);

    private Task<SelectionResult<PluginAddress, DecompileRefusal, NoOutcome>> Decompile(bool force, params PluginAddress[] plugins) =>
        TestEditService.DecompileHandler(_holder).DecompileAsync(plugins, force);

    private Task<SelectionResult<PluginAddress, DecompileRefusal, NoOutcome>> Decompile(IPluginAdapter adapter, params PluginAddress[] plugins) =>
        TestEditService.DecompileHandler(_holder, adapter).DecompileAsync(plugins, force: false);

    private static void WritePlugin(string modFolder, string name, string editorId)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        mod.WriteToBinary(Path.Combine(modFolder, name));
    }

    private ISourceRepository Repository => TestAdapters.Source().Open(new PluginProvider.FromMod(TrackedModName, _trackedMod, _trackedMod), GameRelease.Fallout4).Require();

    private string SourceTextOf(string plugin) => string.Concat(
        TreeDocuments.Of(Repository, Tracked(plugin)).Select(document => document.Body).Order(StringComparer.Ordinal));
}
