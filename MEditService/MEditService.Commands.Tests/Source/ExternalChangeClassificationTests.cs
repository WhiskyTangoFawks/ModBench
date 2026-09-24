using System.Security.Cryptography;
using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.Source;

/// <summary>How a settled mod is classified, observed at the one door the watcher has: a genuine
/// external change is the question it publishes, with the halves it found named on it.</summary>
public sealed class ExternalChangeClassificationTests : IDisposable
{
    private const string PluginName = "Test.esp";
    private const string Origin = "TestMod";

    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly string _instanceRoot = Directory.CreateTempSubdirectory("medit-classify-").FullName;

    private TrackedModSettled Settled => TestEditService.Settled(_notifications);

    private string ModFolder => Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;

    public void Dispose()
    {
        try { Directory.Delete(_instanceRoot, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // The plugin's bytes as the load order finds them: on disk, at the copy's path.
    private LoadOrderSnapshot WithPlugin(byte[] bytes)
    {
        var path = Path.Combine(ModFolder, PluginName);
        File.WriteAllBytes(path, bytes);
        return new LoadOrderSnapshot(_instanceRoot, _instanceRoot, GameRelease.Fallout4,
            [new RegisteredCopy(PluginName, Origin, path, 0, Enabled: true, Winning: true)]);
    }

    private LoadOrderSnapshot WithPlugins(params (string Name, byte[] Bytes)[] plugins)
    {
        foreach (var (name, bytes) in plugins) File.WriteAllBytes(Path.Combine(ModFolder, name), bytes);
        return new LoadOrderSnapshot(_instanceRoot, _instanceRoot, GameRelease.Fallout4,
            [.. plugins.Select((plugin, slot) => new RegisteredCopy(
                plugin.Name, Origin, Path.Combine(ModFolder, plugin.Name), slot, Enabled: true, Winning: true))]);
    }

    private LoadOrderSnapshot WithNoPlugin() =>
        new(_instanceRoot, _instanceRoot, GameRelease.Fallout4, []);

    private QuestionOpenNotification TheQuestion() =>
        Assert.Single(_notifications.Notifications.OfType<QuestionOpenNotification>());

    // ── Self-echo: proven with a REAL Compile, not a fabricated matching hash. ──

    [Fact]
    public async Task ASettle_ReportsNothing_ForTheBinaryARealCompileJustWrote()
    {
        using var mod = SourceEditFixture.Tracked();
        mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", Json("0.75"));
        var compileService = CompileServices.Over(mod.LoadOrder);
        var result = await compileService.CompileAsync(mod.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var outcome = Settled.Handle(mod.LoadOrder, mod.ModFolder);

        Assert.Equal(TrackedModSettledOutcome.NoQuestion, outcome);
        Assert.Empty(_notifications.Notifications);
    }

    [Fact]
    public void ASettle_ReportsTheChangedPlugin_ForBytesTheParkedRefDoesNotName()
    {
        using var mod = SourceEditFixture.Tracked();
        File.WriteAllBytes(Path.Combine(mod.ModFolder, SourceEditFixture.PluginName), "not the tracked binary"u8.ToArray());

        var outcome = Settled.Handle(mod.LoadOrder, mod.ModFolder);

        Assert.Equal(TrackedModSettledOutcome.QuestionOpened, outcome);
        Assert.Equal([SourceEditFixture.PluginName], TheQuestion().Plugins);
        Assert.Empty(TheQuestion().TrackedFiles);
    }

    // ── Crash-marker suppression: crash recovery's territory, never the external-change dialog for the same event. ──

    [Fact]
    public async Task ASettle_ReportsCrashRecovery_WhenAJournalMarkerIsUnfinished_EvenWithAHashMismatch()
    {
        var loadOrder = WithPlugin("anything, hash mismatches regardless"u8.ToArray());
        Track(ModFolder, PluginName);
        await CompileJournal.RunBatchAsync(ModFolder, [PluginName], _ => Task.FromResult(false));

        var outcome = Settled.Handle(loadOrder, ModFolder);

        Assert.Equal(TrackedModSettledOutcome.CrashRecovery, outcome);
        Assert.Equal(nameof(CrashRepairReason.InterruptedCompile), TheQuestion().CrashRepairReason);
    }

    // ── The meta tell: default-button evidence, never acted on by itself (ADR-0003). ──

    [Fact]
    public void ASettle_ReportsMetaChanged_WhenMetaIniVersionMovedSinceTheBaseline()
    {
        var loadOrder = WithPlugin("an external binary"u8.ToArray());
        File.WriteAllText(Path.Combine(ModFolder, "meta.ini"), "version=1.0.0\n");
        Track(ModFolder, PluginName);
        File.WriteAllText(Path.Combine(ModFolder, "meta.ini"), "version=2.0.0\n");

        var outcome = Settled.Handle(loadOrder, ModFolder);

        Assert.Equal(TrackedModSettledOutcome.QuestionOpened, outcome);
        Assert.True(TheQuestion().MetaChanged);
        Assert.Equal("1.0.0", TheQuestion().OldVersion);
        Assert.Equal("2.0.0", TheQuestion().NewVersion);
    }

    // Two plugins share the repository, and only the second was taken again after meta.ini moved:
    // its own baseline, not the other plugin's, says whether meta.ini moved since.
    [Fact]
    public void ASettle_ReadsTheMetaTell_OffTheChangedPluginsOwnBaseline_WhenTwoPluginsShareTheRepository()
    {
        var unchanged = "the first plugin's tracked binary"u8.ToArray();
        var loadOrder = WithPlugins(("First.esp", unchanged), ("Second.esp", "an external binary"u8.ToArray()));
        File.WriteAllText(Path.Combine(ModFolder, "meta.ini"), "version=1.0.0\n");
        SourceRepository.Track(
            ModFolder, SourcePreset.Edits,
            [BaselineOver(ModFolder, "First.esp", Convert.ToHexString(SHA256.HashData(unchanged))), BaselineOver(ModFolder, "Second.esp")]);
        File.WriteAllText(Path.Combine(ModFolder, "meta.ini"), "version=2.0.0\n");
        SourceRepository.CommitPristineToMain(ModFolder, [BaselineOver(ModFolder, "Second.esp")]);

        Settled.Handle(loadOrder, ModFolder);

        Assert.Equal(["Second.esp"], TheQuestion().Plugins);
        Assert.False(TheQuestion().MetaChanged);
        Assert.Equal("2.0.0", TheQuestion().OldVersion);
    }

    // A meta.ini edit with no accompanying plugin or tracked-file change raises nothing at all —
    // the rule's "meta.ini is a tell, never a trigger" half.
    [Fact]
    public void ASettle_ReportsNothing_ForAMetaIniEditAlone()
    {
        File.WriteAllText(Path.Combine(ModFolder, "meta.ini"), "version=1.0.0\n");
        Track(ModFolder, PluginName);
        File.WriteAllText(Path.Combine(ModFolder, "meta.ini"), "version=2.0.0\n");

        var outcome = Settled.Handle(WithNoPlugin(), ModFolder);

        Assert.Equal(TrackedModSettledOutcome.NoQuestion, outcome);
        Assert.Empty(_notifications.Notifications);
    }

    [Fact]
    public void ASettle_ReportsNothing_ForAnUntrackedFolder()
    {
        var loadOrder = WithPlugin("anything"u8.ToArray());

        var outcome = Settled.Handle(loadOrder, ModFolder);

        Assert.Equal(TrackedModSettledOutcome.NoQuestion, outcome);
        Assert.Empty(_notifications.Notifications);
    }

    // ── The tracked-file half: git's own status against the edit branch, outside source/. ──

    [Fact]
    public void ASettle_ReportsTheChangedPath_ForATrackedAssetGitSeesDiffer_WithNoPluginTouched()
    {
        File.WriteAllText(Path.Combine(ModFolder, "texture.dds"), "original");
        TrackEverything(ModFolder, PluginName);
        File.WriteAllText(Path.Combine(ModFolder, "texture.dds"), "changed-by-the-release");

        var outcome = Settled.Handle(WithNoPlugin(), ModFolder);

        Assert.Equal(TrackedModSettledOutcome.QuestionOpened, outcome);
        Assert.Empty(TheQuestion().Plugins);
        Assert.Equal(["texture.dds"], TheQuestion().TrackedFiles);
    }

    [Fact]
    public void ASettle_ReportsBothHalves_WhenAPluginAndATrackedAssetBothChanged()
    {
        var loadOrder = WithPlugin("an external binary"u8.ToArray());
        File.WriteAllText(Path.Combine(ModFolder, "texture.dds"), "original");
        TrackEverything(ModFolder, PluginName);
        File.WriteAllText(Path.Combine(ModFolder, "texture.dds"), "changed-by-the-release");

        var outcome = Settled.Handle(loadOrder, ModFolder);

        Assert.Equal(TrackedModSettledOutcome.QuestionOpened, outcome);
        Assert.Equal([PluginName], TheQuestion().Plugins);
        Assert.Equal(["texture.dds"], TheQuestion().TrackedFiles);
    }

    private static void Track(string modFolder, string plugin)
    {
        SourceRepository.Track(modFolder, SourcePreset.Edits, [BaselineOver(modFolder, plugin)]);
    }

    private static void TrackEverything(string modFolder, string plugin)
    {
        SourceRepository.Track(modFolder, SourcePreset.Everything, [BaselineOver(modFolder, plugin)]);
    }

    // The baseline Track itself writes: the folder's meta facts, plus a stand-in binary hash.
    private static (IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers) BaselineOver(
        string modFolder, string plugin, string binarySha256 = "0000000000")
    {
        var meta = SourceRepository.MetaFactsIn(modFolder);
        return (
            [new TreeFile($"source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray())],
            new BaselineTrailers(plugin, meta.UpstreamVersion, meta.MetaSha256, binarySha256));
    }
}
