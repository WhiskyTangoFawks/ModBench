using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Api;

/// <summary>a-tracked-mod-changes-on-disk: the mod settles, the classifier decides what changed,
/// one question per mod reaches the client, and the human's answer comes back as an envelope whose
/// reply says what landed.</summary>
[Collection(WebHostCollection.Name)]
public sealed class ATrackedModChangesOnDiskApiTests : HostedTests
{
    private const string Plugin = "Watched.esp";
    private const string Origin = "WatchedMod";
    private const string Npc = "WatchedNpc";
    private const string Asset = "texture.dds";
    private const string ChangedAsset = "Meshes/Thing.nif";
    private const string DeletedAsset = "Meshes/Gone.nif";

    // A safety bound against a hang, never the proof: the proof is the settle line itself.
    private static readonly TimeSpan SettleTimeout = TimeSpan.FromSeconds(20);

    private readonly List<LogEntry> _logs = [];

    protected override MEditHost CreateHost() => new(_logs);

    // Where the log stands right now: a caller takes this before the write under test, so the
    // settle it later awaits is one this write produced, never one an earlier step already logged.
    private int LogMark()
    {
        lock (_logs) return _logs.Count;
    }

    // The watcher's own settle completion (ModFolderWatcher, Debug) logged no earlier than
    // <paramref name="since"/>: the module's one signal that a classification — and any question it
    // would have opened — is now final for this mod folder.
    private async Task<bool> AwaitSettleLine(string modFolder, int since, TimeSpan timeout)
    {
        var elapsed = Stopwatch.StartNew();
        while (elapsed.Elapsed < timeout)
        {
            lock (_logs)
            {
                if (_logs.Skip(since).Any(l =>
                    l.Message.Contains(modFolder, StringComparison.Ordinal)
                    && (l.Message.Contains("Live settle of", StringComparison.Ordinal)
                        || l.Message.Contains("Load-time settle of", StringComparison.Ordinal))))
                    return true;
            }
            await Task.Delay(20);
        }
        return false;
    }

    private int _markers;

    // A put that moves every copy one slot: an identical resend is a no-op and publishes nothing,
    // while this one publishes load-order-status carrying its own applied version, so we skip past
    // any unread frame an earlier PUT on this stream already left.
    private async Task<IReadOnlyList<(string Kind, JsonElement Data)>> FramesThroughAMarkerPut(
        StreamReader stream, ScatteredFixtureData fx)
    {
        var offset = ++_markers;
        var response = await Client.PutLoadOrder(fx, fx.Plugins.Select(p => p with { Slot = p.Slot + offset }));
        response.EnsureSuccessStatusCode();
        var applied = await response.Content.ReadFromJsonAsync<JsonElement>();
        var version = applied.GetProperty("version").GetInt64();
        return await stream.FramesThrough(
            "load-order-status", d => d.GetProperty("loadOrderStatus").GetProperty("version").GetInt64() == version);
    }

    private static ScatteredFixtureData OneMod() =>
        new PluginFixtureBuilder("trace-tracked-mod-changes")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.5f, origin: Origin)
            .BuildScattered();

    // Loads, then tracks: the watch over the mod widens itself when Track writes its repository.
    private async Task<ScatteredFixtureData> Watched(string preset = "Edits", Action<string>? beforeTracking = null)
    {
        var fx = OneMod();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        beforeTracking?.Invoke(OtherTool.ModFolderOf(fx, Origin));
        (await Client.Track(Origin, preset)).EnsureSuccessStatusCode();
        await Client.PluginReportsTracked(Plugin);
        return fx;
    }

    private static void ARelease(ScatteredFixtureData fx) =>
        OtherTool.WritesThePlugin(
            fx.Plugins.Single(p => p.Origin == Origin).Path,
            mod =>
            {
                mod.Npcs.AddNew(Npc).HeightMax = 0.9f;
                mod.Npcs.AddNew("AddedByTheRelease");
            });

    // The Everything preset, with two assets git tracks beside the plugin.
    private Task<ScatteredFixtureData> WatchedWithAssets() =>
        Watched("Everything", modFolder =>
        {
            OtherTool.WritesTheFile(Path.Combine(modFolder, ChangedAsset), "original-mesh");
            OtherTool.WritesTheFile(Path.Combine(modFolder, DeletedAsset), "going-away");
        });

    // The whole release: new plugin bytes, an asset rewritten by hand, an asset dropped.
    private static void AReleaseOverTheAssets(ScatteredFixtureData fx)
    {
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        OtherTool.WritesTheFile(Path.Combine(modFolder, ChangedAsset), "new-mesh-bytes");
        OtherTool.DeletesTheFile(Path.Combine(modFolder, DeletedAsset));
        ARelease(fx);
    }

    private Task<HttpResponseMessage> Answer(string verb, string origin) =>
        Client.PostAsJsonAsync($"/plugins/external-change/{verb}", new { origin });

    [Fact]
    public async Task AnsweringForAModNobodyTracked_Is503()
    {
        var fx = Owned(OneMod());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Answer("absorb", Origin)).StatusCode);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Answer("keep", Origin)).StatusCode);
    }

    [Fact]
    public async Task AnsweringForAnOriginNoLoadedPluginHas_Is503()
    {
        Owned(await Watched());

        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Answer("absorb", "NoSuchMod")).StatusCode);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Answer("keep", "NoSuchMod")).StatusCode);
    }

    [Fact]
    public async Task ATrackedPluginRewrittenByAnotherTool_OpensOneQuestion_AndTheBaselineAnswerApplies()
    {
        var fx = Owned(await Watched());
        using var stream = await Client.NotificationStream();

        ARelease(fx);

        var question = Assert.Single(await stream.EventsUntil("question-open"));
        Assert.Equal(Origin, question.GetProperty("origin").GetString());
        Assert.Contains(Plugin, question.GetProperty("keys").EnumerateArray().Select(k => k.GetString()));

        var answered = await Answer("absorb", Origin);

        answered.EnsureSuccessStatusCode();
        var outcome = await answered.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(outcome.GetProperty("succeeded").GetBoolean(), outcome.GetProperty("refusalReason").GetString());
        Assert.Equal("Clean", outcome.GetProperty("rebase").GetProperty("outcome").GetString());
    }

    [Fact]
    public async Task AChangedAssetUnderEverything_OpensAQuestionNamingThePath()
    {
        var fx = Owned(await Watched(
            "Everything", modFolder => OtherTool.WritesTheFile(Path.Combine(modFolder, Asset), "original")));
        using var stream = await Client.NotificationStream();

        OtherTool.WritesTheFile(Path.Combine(OtherTool.ModFolderOf(fx, Origin), Asset), "changed-by-the-release");

        var question = Assert.Single(await stream.EventsUntil("question-open"));
        Assert.Empty(question.GetProperty("keys").EnumerateArray());
        Assert.Contains(
            Asset, question.GetProperty("externalChangeTrackedFiles").EnumerateArray().Select(k => k.GetString()));
    }

    [Fact]
    public async Task TheSameAssetChangeUnderEdits_OpensNoQuestion()
    {
        var fx = Owned(await Watched(
            beforeTracking: modFolder => OtherTool.WritesTheFile(Path.Combine(modFolder, Asset), "original")));
        using var stream = await Client.NotificationStream();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);

        var since = LogMark();
        OtherTool.WritesTheFile(Path.Combine(modFolder, Asset), "changed-by-the-release");

        Assert.True(await AwaitSettleLine(modFolder, since, SettleTimeout), "never saw the watcher's settle line");
        var frames = await FramesThroughAMarkerPut(stream, fx);
        Assert.DoesNotContain(frames, f => f.Kind == "question-open");
    }

    // meta.ini is a tell, never a trigger: its version chooses the default answer to a question
    // something else opened.
    [Fact]
    public async Task AMetaIniVersionBumpAlone_OpensNoQuestion()
    {
        var fx = Owned(await Watched(
            beforeTracking: modFolder => OtherTool.WritesTheFile(Path.Combine(modFolder, "meta.ini"), "version=1.0.0\n")));
        using var stream = await Client.NotificationStream();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);

        var since = LogMark();
        OtherTool.WritesTheFile(Path.Combine(modFolder, "meta.ini"), "version=2.0.0\n");

        Assert.True(await AwaitSettleLine(modFolder, since, SettleTimeout), "never saw the watcher's settle line");
        var frames = await FramesThroughAMarkerPut(stream, fx);
        Assert.DoesNotContain(frames, f => f.Kind == "question-open");
    }

    // One dialog per mod: a release-sized burst reaches the client as a question that names the
    // whole release, not one question per file.
    [Fact]
    public async Task AReleaseTouchingManyFiles_OpensOneQuestionNamingAllOfThem()
    {
        var assets = Enumerable.Range(0, 20).Select(i => $"asset{i:D2}.dds").ToList();
        var fx = Owned(await Watched("Everything", modFolder =>
        {
            foreach (var name in assets) OtherTool.WritesTheFile(Path.Combine(modFolder, name), "original");
        }));
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        using var stream = await Client.NotificationStream();

        foreach (var name in assets)
            OtherTool.WritesTheFile(Path.Combine(modFolder, name), "changed-by-the-release");
        ARelease(fx);

        var question = Assert.Single(await stream.EventsUntil("question-open"));

        var named = question.GetProperty("externalChangeTrackedFiles").EnumerateArray()
            .Select(file => file.GetString()).ToList();
        Assert.All(assets, name => Assert.Contains(name, named));
    }

    [Fact]
    public async Task AChangeMadeWhileTheServiceWasDown_IsClassifiedAtTheNextLoad()
    {
        var fx = Owned(await Watched(
            "Everything", modFolder => OtherTool.WritesTheFile(Path.Combine(modFolder, Asset), "original")));
        Restart();

        OtherTool.WritesTheFile(
            Path.Combine(OtherTool.ModFolderOf(fx, Origin), Asset), "changed-while-medit-was-down");
        using var stream = await Client.NotificationStream();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var question = Assert.Single(await stream.EventsUntil("question-open"));
        Assert.Contains(
            Asset, question.GetProperty("externalChangeTrackedFiles").EnumerateArray().Select(k => k.GetString()));
    }

    [Theory]
    [InlineData("absorb")]
    [InlineData("keep")]
    public async Task AnAnsweredQuestion_StaysAnsweredAcrossARestart(string verb)
    {
        var fx = Owned(await Watched());
        using (var stream = await Client.NotificationStream())
        {
            ARelease(fx);
            await stream.EventsUntil("question-open");
        }
        (await Answer(verb, Origin)).EnsureSuccessStatusCode();

        Restart();

        using var afterRestart = await Client.NotificationStream();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var since = LogMark();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        Assert.True(await AwaitSettleLine(modFolder, since, SettleTimeout), "never saw the load-time settle line");
        var frames = await FramesThroughAMarkerPut(afterRestart, fx);
        Assert.DoesNotContain(frames, f => f.Kind == "question-open");
    }

    [Theory]
    [InlineData("absorb")]
    [InlineData("keep")]
    public async Task AnsweringForAnOriginNoLoadOrderHolds_Is503(string verb)
    {
        Owned(await Watched());

        var response = await Answer(verb, "NoSuchMod");

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }

    // The same 200-with-a-refusal posture both answers have: an outcome the dialog can show, not a
    // transport failure.
    [Fact]
    public async Task KeepingAChangeThatCollidesWithALocalEdit_RefusesInsideA200_NamingTheRecord()
    {
        var fx = Owned(await Watched());
        var formKey = await Client.FirstFormKey(Plugin);
        (await Client.Edit(formKey, Plugin, Origin, "HeightMax", 0.25)).EnsureSuccessStatusCode();
        using var stream = await Client.NotificationStream();
        ARelease(fx);
        await stream.EventsUntil("question-open");

        var answered = await Answer("keep", Origin);

        answered.EnsureSuccessStatusCode();
        var outcome = await answered.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(outcome.GetProperty("succeeded").GetBoolean());
        Assert.Contains(formKey, outcome.GetProperty("refusalReason").GetString().Require(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task KeepingAChangeThatCannotBeWritten_IsAShapedProblem_NotAnUnhandled500()
    {
        var fx = Owned(await Watched());
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        using var stream = await Client.NotificationStream();
        ARelease(fx);
        await stream.EventsUntil("question-open");

        OtherTool.SetsThePermissions(modFolder, "500");
        try
        {
            var answered = await Answer("keep", Origin);

            Assert.Equal(HttpStatusCode.InternalServerError, answered.StatusCode);
            var problem = await answered.Content.ReadFromJsonAsync<JsonElement>();
            Assert.False(string.IsNullOrWhiteSpace(problem.GetProperty("detail").GetString()));
        }
        finally
        {
            OtherTool.SetsThePermissions(modFolder, "700");
        }
    }

    [Fact]
    public async Task TheBaselineAnswerOverALocalEdit_LandsTheBaselineAndRefusesTheRebaseNamingThePath()
    {
        var fx = Owned(await Watched());
        var formKey = await Client.FirstFormKey(Plugin);
        (await Client.Edit(formKey, Plugin, Origin, "HeightMax", 0.25)).EnsureSuccessStatusCode();
        using var stream = await Client.NotificationStream();
        ARelease(fx);
        await stream.EventsUntil("question-open");

        var answered = await Answer("absorb", Origin);

        answered.EnsureSuccessStatusCode();
        var outcome = await answered.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(
            outcome.GetProperty("succeeded").GetBoolean(),
            "the baseline commit lands even when the rebase that follows refuses");
        var rebase = outcome.GetProperty("rebase");
        Assert.Equal("Refused", rebase.GetProperty("outcome").GetString());
        Assert.Contains(".json", rebase.GetProperty("refusalReason").GetString().Require(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task RebasingACleanEditBranch_ReportsClean()
    {
        Owned(await Watched());

        var rebased = await Client.PostAsJsonAsync("/plugins/rebase", new { origin = Origin });

        rebased.EnsureSuccessStatusCode();
        Assert.Equal(
            "Clean",
            (await rebased.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("outcome").GetString());
    }

    [Theory]
    [InlineData("/plugins/rebase")]
    [InlineData("/plugins/rebase/continue")]
    public async Task RebasingAnOriginNoLoadOrderHolds_Is404(string route)
    {
        Owned(await Watched());

        var response = await Client.PostAsJsonAsync(route, new { origin = "NoSuchMod" });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // ADR-0003: the answer covers every changed tracked file, not the plugin alone. A baseline that
    // took only the plugin would leave both assets differing from git, and the next load would ask
    // the same question again.
    [Fact]
    public async Task TheBaselineAnswerUnderEverything_TakesTheChangedAndTheDroppedAssetToo()
    {
        var fx = Owned(await WatchedWithAssets());
        using (var stream = await Client.NotificationStream())
        {
            AReleaseOverTheAssets(fx);
            var question = Assert.Single(await stream.EventsUntil("question-open"));
            var files = question.GetProperty("externalChangeTrackedFiles").EnumerateArray()
                .Select(file => file.GetString()).ToList();
            Assert.Contains(ChangedAsset, files);
            Assert.Contains(DeletedAsset, files);
        }

        var answered = await Answer("absorb", Origin);

        answered.EnsureSuccessStatusCode();
        var outcome = await answered.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(outcome.GetProperty("succeeded").GetBoolean(), outcome.GetProperty("refusalReason").GetString());

        Restart();
        using var afterRestart = await Client.NotificationStream();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var since = LogMark();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        Assert.True(await AwaitSettleLine(modFolder, since, SettleTimeout), "never saw the load-time settle line");
        var frames = await FramesThroughAMarkerPut(afterRestart, fx);
        Assert.DoesNotContain(frames, f => f.Kind == "question-open");
    }

    // Keep answers the question and stages what it landed, so a second release touching the same
    // asset finds it already dirty in the index and is refused by name.
    [Fact]
    public async Task KeepingAnAssetTheLastKeepStaged_RefusesInsideA200_NamingThePath()
    {
        var fx = Owned(await WatchedWithAssets());
        using (var first = await Client.NotificationStream())
        {
            AReleaseOverTheAssets(fx);
            await first.EventsUntil("question-open");
        }
        var kept = await Answer("keep", Origin);
        kept.EnsureSuccessStatusCode();
        Assert.True(
            (await kept.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("succeeded").GetBoolean(),
            "keep must land the asset change before a second one can find it staged");

        using var second = await Client.NotificationStream();
        OtherTool.WritesTheFile(Path.Combine(OtherTool.ModFolderOf(fx, Origin), ChangedAsset), "newer-mesh-bytes");
        await second.EventsUntil("question-open");

        var answered = await Answer("keep", Origin);

        answered.EnsureSuccessStatusCode();
        var outcome = await answered.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(outcome.GetProperty("succeeded").GetBoolean());
        Assert.Contains(ChangedAsset, outcome.GetProperty("refusalReason").GetString().Require(), StringComparison.Ordinal);
    }
}
