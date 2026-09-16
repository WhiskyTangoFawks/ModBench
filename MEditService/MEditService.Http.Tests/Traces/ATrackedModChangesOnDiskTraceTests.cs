using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Tests.Api;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Traces;

/// <summary>a-tracked-mod-changes-on-disk: the mod settles, the classifier decides what changed,
/// one question per mod reaches the client, and the human's answer comes back as an envelope whose
/// reply says what landed.</summary>
[Collection(WebHostCollection.Name)]
public sealed class ATrackedModChangesOnDiskTraceTests : IDisposable
{
    private const string Plugin = "Watched.esp";
    private const string Origin = "WatchedMod";
    private const string Npc = "WatchedNpc";
    private const string Asset = "texture.dds";

    // Outlasts the watcher's own settle window, so a question that should not have opened has had
    // its chance to.
    private static readonly TimeSpan Settled = TimeSpan.FromSeconds(2);

    private MEditHost _app = new();
    private HttpClient _client;

    public ATrackedModChangesOnDiskTraceTests() => _client = _app.CreateClient();

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
    }

    private static ScatteredFixtureData OneMod() =>
        new PluginFixtureBuilder("trace-tracked-mod-changes")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.5f, origin: Origin)
            .BuildScattered();

    // Loads, tracks, then loads again: the second PUT hands the watcher the value it just put, which
    // is what arms the watch over a mod that was untracked a moment ago.
    private async Task<ScatteredFixtureData> Watched(string preset = "Edits", Action<string>? beforeTracking = null)
    {
        var fx = OneMod();
        (await _client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        beforeTracking?.Invoke(OtherTool.ModFolderOf(fx, Origin));
        (await _client.Track(Origin, preset)).EnsureSuccessStatusCode();
        (await _client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
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

    private Task<HttpResponseMessage> Answer(string verb, string origin) =>
        _client.PostAsJsonAsync($"/plugins/external-change/{verb}", new { origin });

    [Fact]
    public async Task ATrackedPluginRewrittenByAnotherTool_OpensOneQuestion_AndTheBaselineAnswerApplies()
    {
        using var fx = await Watched();
        using var stream = await _client.NotificationStream();

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
        using var fx = await Watched(
            "Everything", modFolder => OtherTool.WritesTheFile(Path.Combine(modFolder, Asset), "original"));
        using var stream = await _client.NotificationStream();

        OtherTool.WritesTheFile(Path.Combine(OtherTool.ModFolderOf(fx, Origin), Asset), "changed-by-the-release");

        var question = Assert.Single(await stream.EventsUntil("question-open"));
        Assert.Empty(question.GetProperty("keys").EnumerateArray());
        Assert.Contains(
            Asset, question.GetProperty("externalChangeTrackedFiles").EnumerateArray().Select(k => k.GetString()));
    }

    [Fact]
    public async Task TheSameAssetChangeUnderEdits_OpensNoQuestion()
    {
        using var fx = await Watched(
            beforeTracking: modFolder => OtherTool.WritesTheFile(Path.Combine(modFolder, Asset), "original"));
        using var stream = await _client.NotificationStream();

        OtherTool.WritesTheFile(Path.Combine(OtherTool.ModFolderOf(fx, Origin), Asset), "changed-by-the-release");

        await stream.NoEventOf("question-open", Settled);
    }

    // meta.ini is a tell, never a trigger: its version chooses the default answer to a question
    // something else opened.
    [Fact]
    public async Task AMetaIniVersionBumpAlone_OpensNoQuestion()
    {
        using var fx = await Watched(
            beforeTracking: modFolder => OtherTool.WritesTheFile(Path.Combine(modFolder, "meta.ini"), "version=1.0.0\n"));
        using var stream = await _client.NotificationStream();

        OtherTool.WritesTheFile(Path.Combine(OtherTool.ModFolderOf(fx, Origin), "meta.ini"), "version=2.0.0\n");

        await stream.NoEventOf("question-open", Settled);
    }

    [Fact]
    public async Task AReleaseTouchingManyFilesInOneWindow_OpensExactlyOneQuestion()
    {
        var assets = Enumerable.Range(0, 20).Select(i => $"asset{i:D2}.dds").ToList();
        using var fx = await Watched("Everything", modFolder =>
        {
            foreach (var name in assets) OtherTool.WritesTheFile(Path.Combine(modFolder, name), "original");
        });
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        using var stream = await _client.NotificationStream();

        foreach (var name in assets)
            OtherTool.WritesTheFile(Path.Combine(modFolder, name), "changed-by-the-release");
        ARelease(fx);

        Assert.Single(await stream.EventsUntil("question-open"));
        await stream.NoEventOf("question-open", Settled);
    }

    [Fact]
    public async Task AChangeMadeWhileTheServiceWasDown_IsClassifiedAtTheNextLoad()
    {
        using var fx = await Watched(
            "Everything", modFolder => OtherTool.WritesTheFile(Path.Combine(modFolder, Asset), "original"));
        Restart();

        OtherTool.WritesTheFile(
            Path.Combine(OtherTool.ModFolderOf(fx, Origin), Asset), "changed-while-medit-was-down");
        using var stream = await _client.NotificationStream();
        (await _client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var question = Assert.Single(await stream.EventsUntil("question-open"));
        Assert.Contains(
            Asset, question.GetProperty("externalChangeTrackedFiles").EnumerateArray().Select(k => k.GetString()));
    }

    [Theory]
    [InlineData("absorb")]
    [InlineData("keep")]
    public async Task AnAnsweredQuestion_StaysAnsweredAcrossARestart(string verb)
    {
        using var fx = await Watched();
        using (var stream = await _client.NotificationStream())
        {
            ARelease(fx);
            await stream.EventsUntil("question-open");
        }
        (await Answer(verb, Origin)).EnsureSuccessStatusCode();

        Restart();

        using var afterRestart = await _client.NotificationStream();
        (await _client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        await afterRestart.NoEventOf("question-open", Settled);
    }

    [Theory]
    [InlineData("absorb")]
    [InlineData("keep")]
    public async Task AnsweringForAnOriginNoLoadOrderHolds_Is503(string verb)
    {
        using var fx = await Watched();

        var response = await Answer(verb, "NoSuchMod");

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }

    // The same 200-with-a-refusal posture both answers have: an outcome the dialog can show, not a
    // transport failure.
    [Fact]
    public async Task KeepingAChangeThatCollidesWithALocalEdit_RefusesInsideA200_NamingTheRecord()
    {
        using var fx = await Watched();
        var formKey = await _client.FirstFormKey(Plugin);
        (await _client.Edit(formKey, Plugin, Origin, "HeightMax", 0.25)).EnsureSuccessStatusCode();
        using var stream = await _client.NotificationStream();
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
        using var fx = await Watched();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        using var stream = await _client.NotificationStream();
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
        using var fx = await Watched();
        var formKey = await _client.FirstFormKey(Plugin);
        (await _client.Edit(formKey, Plugin, Origin, "HeightMax", 0.25)).EnsureSuccessStatusCode();
        using var stream = await _client.NotificationStream();
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
        using var fx = await Watched();

        var rebased = await _client.PostAsJsonAsync("/plugins/rebase", new { origin = Origin });

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
        using var fx = await Watched();

        var response = await _client.PostAsJsonAsync(route, new { origin = "NoSuchMod" });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // Stop the service and start it again: the same mod on disk, a new process, nothing carried over
    // in memory.
    private void Restart()
    {
        _client.Dispose();
        _app.Dispose();
        _app = new MEditHost();
        _client = _app.CreateClient();
    }
}
