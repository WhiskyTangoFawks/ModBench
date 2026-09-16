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

/// <summary>track-a-plugin: Track reads the plugin's bytes into documents once, reports its
/// progress per plugin, and arms the watch that carries a later hand edit back into the
/// answers.</summary>
[Collection(WebHostCollection.Name)]
public sealed class TrackAPluginTraceTests : IDisposable
{
    private const string Plugin = "Tracked.esp";
    private const string Origin = "TrackedMod";
    private const string Npc = "TrackedNpc";

    private readonly MEditHost _app = new();
    private readonly HttpClient _client;
    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("trace-track-a-plugin")
        .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc), origin: Origin)
        .BuildScattered();

    public TrackAPluginTraceTests() => _client = _app.CreateClient();

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
        _instance.Dispose();
    }

    private async Task Loaded() => (await _client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();

    [Fact]
    public async Task TrackingALoadedMod_AnswersWithTheOrigin_ReportsItsProgress_AndLeavesThePluginEditable()
    {
        await Loaded();
        using var stream = await _client.NotificationStream();

        var tracked = await _client.Track(Origin);

        tracked.EnsureSuccessStatusCode();
        var body = await tracked.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(Origin, body.GetProperty("origin").GetString());

        var progress = await stream.EventsUntil(
            "track-progress", e => e.GetProperty("trackProgress").GetProperty("phase").GetString() == "Idle");
        Assert.Contains(progress, e => e.GetProperty("trackProgress").GetProperty("origin").GetString() == Origin);

        // Editing is what Track is for, and an edit is refused on a plugin no repository holds, so
        // an applied edit is the tracked repository answering.
        var edit = await _client.Edit(await _client.FirstFormKey(Plugin), Plugin, Origin, "HeightMax", 0.75);
        edit.EnsureSuccessStatusCode();
        Assert.True((await edit.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("applied").GetBoolean());
    }

    [Fact]
    public async Task TrackingWithoutAnOrigin_Is400()
    {
        await Loaded();

        var response = await _client.Track(string.Empty);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task TrackingAnOriginNoLoadedPluginHas_Is404()
    {
        await Loaded();

        var response = await _client.Track("NoSuchMod");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task TrackingAModAlreadyTracked_Is409()
    {
        await Loaded();
        (await _client.Track(Origin)).EnsureSuccessStatusCode();

        var again = await _client.Track(Origin);

        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
    }

    // ADR-0015 invariant 2: no load order is put between the Track and the hand edit, so the tracked
    // copy can only have reached the answers through the watch Track's own write armed.
    [Fact]
    public async Task AfterTrack_AHandEditToTheSourceTree_ReachesTheNextQuery_WithNoLoadOrderInBetween()
    {
        await Loaded();
        (await _client.Track(Origin)).EnsureSuccessStatusCode();
        var formKey = await _client.FirstFormKey(Plugin);
        var before = await _client.Sequence();

        OtherTool.EditsASourceDocument(OtherTool.ModFolderOf(_instance, Origin), Plugin, Npc, "RenamedByHand");

        await _client.SequenceReaches(before + 1);
        Assert.Equal("RenamedByHand", (await _client.Record(formKey)).GetProperty("editorId").GetString());
    }
}
