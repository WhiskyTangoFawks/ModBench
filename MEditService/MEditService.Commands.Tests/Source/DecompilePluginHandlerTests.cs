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

/// <summary>commands.md, <c>decompile</c>: each plugin's bytes read into its plugin source, in the
/// working tree of the checked-out branch, committing nothing — over a fixture mod and real git.</summary>
public sealed class DecompilePluginHandlerTests : IDisposable
{
    private const string TrackedModName = "TrackedMod";
    private const string UntrackedModName = "UntrackedMod";
    private readonly string _root = Directory.CreateTempSubdirectory("medit-decompile-").FullName;
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

    public void Dispose() => Directory.Delete(_root, recursive: true);

    [Fact]
    public async Task Decompile_OfAnUntrackedPluginInATrackedMod_WritesItsSourceToTheWorkingTree_AndCommitsNothing()
    {
        var mainBefore = Git("rev-parse", "refs/heads/main");

        var result = await Decompile(Tracked("Second.esp"));

        Assert.Equal([Tracked("Second.esp")], result.Landed);
        Assert.Empty(result.Refused);
        Assert.True(SourceRepository.HoldsTreeFor(_trackedMod, "Second.esp"));
        Assert.Contains("SecondNpc", SourceTextOf("Second.esp"), StringComparison.Ordinal);
        Assert.Equal(mainBefore, Git("rev-parse", "refs/heads/main"));
        Assert.Equal("main", Git("symbolic-ref", "--short", "HEAD").Trim());
        Assert.Equal(["?? plugin-source/Second.esp/"], Git("status", "--porcelain").Split('\n', StringSplitOptions.RemoveEmptyEntries));
    }

    // ADR-0003 invariant 3: the bytes decompiled are the bytes Modbench last related to the source, so
    // they read as unchanged.
    [Fact]
    public async Task Decompile_ParksThePluginsBytes_AsTheOnesItsSourceWasMadeFrom()
    {
        await Decompile(Tracked("Second.esp"));

        Assert.Equal(
            [PluginBinaryHash.TrailerFormOfFile(Path.Combine(_trackedMod, "Second.esp"))],
            SourceRepository.ParkedCompileBinarySha256s(_trackedMod, "Second.esp"));
    }

    // plugins.md, Decompile: it replaces the source in the working tree from the bytes, a hand edit
    // and a document the bytes do not hold included.
    [Fact]
    public async Task Decompile_OfATrackedPlugin_ReplacesItsSourceInTheWorkingTree_WithWhatItsBytesHold()
    {
        var stray = Path.Combine(SourceRepository.RootIn(_trackedMod, "First.esp"), "Stray.json");
        File.WriteAllText(stray, "{}");
        var document = OtherToolDocumentCarrying("First.esp", "FirstNpc");
        File.WriteAllText(document, File.ReadAllText(document).Replace("FirstNpc", "EditedByHand", StringComparison.Ordinal));
        WritePlugin(_trackedMod, "First.esp", "UpgradedNpc");

        var result = await Decompile(Tracked("First.esp"));

        Assert.Equal([Tracked("First.esp")], result.Landed);
        Assert.False(File.Exists(stray));
        var text = SourceTextOf("First.esp");
        Assert.Contains("UpgradedNpc", text, StringComparison.Ordinal);
        Assert.DoesNotContain("EditedByHand", text, StringComparison.Ordinal);
        Assert.Equal(["Track TrackedMod", "Track First.esp"], SubjectsOnMain());
    }

    [Fact]
    public async Task Decompile_OfAPluginInAModWithNoRepository_RefusesIt_AndWritesNothing()
    {
        var result = await Decompile(new PluginAddress("Other.esp", UntrackedModName));

        Assert.Empty(result.Landed);
        var refused = Assert.Single(result.Refused);
        Assert.Equal(DecompileRefusal.NotInTrackedMod, refused.Refusal);
        Assert.Contains("Other.esp", refused.Message, StringComparison.Ordinal);
        Assert.Equal(["Other.esp"], Directory.EnumerateFileSystemEntries(_untrackedMod).Select(Path.GetFileName));
    }

    [Fact]
    public async Task Decompile_OfASelection_LandsEachPluginOnItsOwn_ANotLoadedOneRefusedByName()
    {
        var result = await Decompile(new PluginAddress("NoSuch.esp", TrackedModName), Tracked("Second.esp"));

        Assert.Equal([Tracked("Second.esp")], result.Landed);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((new PluginAddress("NoSuch.esp", TrackedModName), DecompileRefusal.PluginNotLoaded), (refused.Plugin, refused.Refusal));
    }

    // ADR-0006 decision 2: a plugin that does not survive its own source is refused, and the source it
    // had stays as it was.
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

    private string SourceTextOf(string plugin) => string.Concat(
        Directory.EnumerateFiles(SourceRepository.RootIn(_trackedMod, plugin), "*", SearchOption.AllDirectories)
            .Order(StringComparer.Ordinal)
            .Select(File.ReadAllText));

    private string OtherToolDocumentCarrying(string plugin, string text) =>
        Directory.EnumerateFiles(SourceRepository.RootIn(_trackedMod, plugin), "*.json", SearchOption.AllDirectories)
            .Single(file => File.ReadAllText(file).Contains(text, StringComparison.Ordinal));

    private string[] SubjectsOnMain() =>
        Git("log", "--reverse", "--format=%s", "refs/heads/main").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_trackedMod, ".git"), _trackedMod, args);
}
