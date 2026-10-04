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
using Noggog.WorkEngine;

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
        WritePlugin(_trackedMod, "Second.esp", "SecondNpc");
        WritePlugin(_untrackedMod, "Other.esp", "OtherNpc");
        var game = Directory.CreateDirectory(Path.Combine(_root, "game")).FullName;
        _holder.Apply(SnapshotPlugins.Snapshot(game, _root, GameRelease.Fallout4,
        [
            new LoadOrderEntry("First.esp", Path.Combine(_trackedMod, "First.esp"), TrackedModName, 0, Enabled: true, Winning: true),
            new LoadOrderEntry("Second.esp", Path.Combine(_trackedMod, "Second.esp"), TrackedModName, 1, Enabled: true, Winning: true),
            new LoadOrderEntry("Other.esp", Path.Combine(_untrackedMod, "Other.esp"), UntrackedModName, 2, Enabled: true, Winning: true),
        ]));
        var tracked = TestEditService.TrackHandler(_holder)
            .TrackAsync([Tracked("First.esp")], SourcePreset.Edits, new Dictionary<string, string>())
            .GetAwaiter().GetResult();
        Assert.Equal([Tracked("First.esp")], tracked.Landed);
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

        Assert.Equal([Tracked("Second.esp")], result.Landed);
        Assert.Empty(result.Refused);
        Assert.Contains("SecondNpc", SourceTextOf("Second.esp"), StringComparison.Ordinal);
        Assert.Equal(headBefore, Head());
    }

    [Fact]
    public async Task Decompile_ParksThePluginsBytes_AsTheOnesItsSourceWasMadeFrom()
    {
        await Decompile(Tracked("Second.esp"));

        Assert.Equal(
            [PluginBinaryHash.TrailerFormOfFile(Path.Combine(_trackedMod, "Second.esp"))],
            SourceRepository.ParkedCompileBinarySha256s(_trackedMod, "Second.esp"));
    }

    [Fact]
    public async Task Decompile_OfATrackedPlugin_ReplacesItsSourceInTheWorkingTree_WithWhatItsBytesHold_DiscardingHandEditsAndStrayDocuments()
    {
        var first = Repository.ReadAll(Tracked("First.esp")).Single(document => document.EditorId == "FirstNpc");
        var identity = new RecordIdentity(first.FormKey, first.RecordType, first.EditorId);
        var stray = TreeTampering.Stray(_trackedMod, Tracked("First.esp"), identity, "Stray.json", "{}");
        TrackedTree.Overwrite(
            _trackedMod, Tracked("First.esp"), identity, first.Body.Replace("FirstNpc", "EditedByHand", StringComparison.Ordinal));
        WritePlugin(_trackedMod, "First.esp", "UpgradedNpc");

        var result = await Decompile(Tracked("First.esp"));

        Assert.Equal([Tracked("First.esp")], result.Landed);
        Assert.False(File.Exists(stray));
        var text = SourceTextOf("First.esp");
        Assert.Contains("UpgradedNpc", text, StringComparison.Ordinal);
        Assert.DoesNotContain("EditedByHand", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Decompile_OfAPluginInAModWithNoRepository_RefusesIt_AndWritesNothing()
    {
        var result = await Decompile(new PluginAddress("Other.esp", UntrackedModName));

        Assert.Empty(result.Landed);
        var refused = Assert.Single(result.Refused);
        Assert.Equal(DecompileRefusal.NotInTrackedMod, refused.Refusal);
        Assert.Contains("Other.esp", refused.Message, StringComparison.Ordinal);
        Assert.Empty(SourceRepository.Over(_untrackedMod, GameRelease.Fallout4).ReadAll(new PluginAddress("Other.esp", UntrackedModName)));
    }

    [Fact]
    public async Task Decompile_OfASelection_LandsEachPluginOnItsOwn_ANotLoadedOneRefusedByName()
    {
        var result = await Decompile(new PluginAddress("NoSuch.esp", TrackedModName), Tracked("Second.esp"));

        Assert.Equal([Tracked("Second.esp")], result.Landed);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((new PluginAddress("NoSuch.esp", TrackedModName), DecompileRefusal.PluginNotLoaded), (refused.Plugin, refused.Refusal));
    }

    [Fact]
    public async Task Decompile_OfAPluginThatFailsItsRoundTripGate_RefusesIt_AndLeavesItsSourceAsItWas()
    {
        var before = SourceTextOf("First.esp");
        WritePlugin(_trackedMod, "First.esp", "UpgradedNpc");

        var result = await Decompile(new ForgedTreeWriteAdapter("First.esp", DeserializeThenCorruptTheNpc), Tracked("First.esp"));

        var refused = Assert.Single(result.Refused);
        Assert.Equal(DecompileRefusal.RoundTripFailed, refused.Refusal);
        Assert.Equal(before, SourceTextOf("First.esp"));
    }

    private static async Task<IMod> DeserializeThenCorruptTheNpc(string folder, CancellationToken cancel)
    {
        var deserialized = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, cancel);
        deserialized.Npcs.First().EditorID += "Corrupted";
        return deserialized;
    }

    private static PluginAddress Tracked(string plugin) => new(plugin, TrackedModName);

    private Task<DecompileSelectionResult> Decompile(params PluginAddress[] plugins) =>
        TestEditService.DecompileHandler(_holder).DecompileAsync(plugins);

    private Task<DecompileSelectionResult> Decompile(IPluginAdapter adapter, params PluginAddress[] plugins) =>
        TestEditService.DecompileHandler(_holder, adapter).DecompileAsync(plugins);

    private static void WritePlugin(string modFolder, string name, string editorId)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        mod.WriteToBinary(Path.Combine(modFolder, name));
    }

    private SourceRepository Repository => SourceRepository.Open(_trackedMod, GameRelease.Fallout4).Require();

    private string SourceTextOf(string plugin) => string.Concat(
        Repository.ReadAll(Tracked(plugin)).Select(document => document.Body).Order(StringComparer.Ordinal));
}
