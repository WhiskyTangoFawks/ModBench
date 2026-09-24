using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Traces;

/// <summary>decompile-plugin to the repository, fired by track: each plugin applied or refused on
/// its own, progress per plugin, and a hand edit reaching the answers. The destinations main and
/// the working tree are debt #966.</summary>
[Collection(WebHostCollection.Name)]
public sealed class DecompilePluginTraceTests : HostedTests
{
    private const string Plugin = "Tracked.esp";
    private const string Origin = "TrackedMod";
    private const string Npc = "TrackedNpc";

    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("trace-decompile-plugin")
        .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc), origin: Origin)
        .BuildScattered();

    protected override void DisposeFixtures() => _instance.Dispose();

    private async Task Loaded() => (await Client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();

    [Fact]
    public async Task TrackingALoadedPlugin_AnswersItApplied_ReportsItsProgress_AndLeavesItEditable()
    {
        await Loaded();
        using var stream = await Client.NotificationStream();

        var tracked = await Client.Track(Plugin, Origin);

        tracked.EnsureSuccessStatusCode();
        var body = await tracked.Content.ReadFromJsonAsync<JsonElement>();
        var applied = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.Equal((Plugin, Origin), (applied.GetProperty("name").GetString(), applied.GetProperty("origin").GetString()));
        Assert.Empty(body.GetProperty("refused").EnumerateArray());

        var progress = await stream.EventsUntil(
            "track-progress", e => e.GetProperty("trackProgress").GetProperty("phase").GetString() == "Idle");
        Assert.Contains(progress, e => e.GetProperty("trackProgress").GetProperty("origin").GetString() == Origin);

        // Editing is what Track is for, and an edit is refused on a plugin no repository holds, so
        // an applied edit is the tracked repository answering.
        var edit = await Client.Edit(await Client.FirstFormKey(Plugin), Plugin, Origin, "HeightMax", 0.75);
        edit.EnsureSuccessStatusCode();
        Assert.True((await edit.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("applied").GetBoolean());
    }

    [Fact]
    public async Task TrackingNoPlugin_Is400()
    {
        await Loaded();

        var response = await Client.Track([]);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task TrackingAPluginWithoutAnOrigin_Is400()
    {
        await Loaded();

        var response = await Client.Track(Plugin, string.Empty);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task TrackingASelection_AnswersEachPluginOnItsOwn_ANotLoadedOneRefusedByName()
    {
        await Loaded();

        var response = await Client.Track([(Plugin, Origin), ("NoSuch.esp", "NoSuchMod")]);

        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal([Plugin], body.GetProperty("applied").EnumerateArray().Select(p => p.GetProperty("name").GetString()));
        var refused = Assert.Single(body.GetProperty("refused").EnumerateArray());
        Assert.Equal("NoSuch.esp", refused.GetProperty("plugin").GetProperty("name").GetString());
        Assert.Equal("NoSuchMod", refused.GetProperty("plugin").GetProperty("origin").GetString());
        Assert.Equal("PluginNotLoaded", refused.GetProperty("refusal").GetString());
        Assert.Contains("NoSuch.esp", refused.GetProperty("message").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task TrackingAPluginAlreadyTracked_AnswersItRefused()
    {
        await Loaded();
        (await Client.Track(Plugin, Origin)).EnsureSuccessStatusCode();

        var again = await Client.Track(Plugin, Origin);

        again.EnsureSuccessStatusCode();
        var refused = Assert.Single((await again.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refused").EnumerateArray());
        Assert.Equal("AlreadyTracked", refused.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task AfterTrackAndTheNextSnapshot_ThePluginListReportsTheCopyTracked()
    {
        await Loaded();
        Assert.False((await Client.Plugin(Plugin)).GetProperty("isTracked").GetBoolean());
        (await Client.Track(Plugin, Origin)).EnsureSuccessStatusCode();

        (await Client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();

        Assert.True((await Client.Plugin(Plugin)).GetProperty("isTracked").GetBoolean());
    }

    // ADR-0015 invariant 2: no load order is put between the Track and the hand edit, so the tracked
    // copy can only have reached the answers through the watch Track's own write armed.
    [Fact]
    public async Task AfterTrack_AHandEditToTheSourceTree_ReachesTheNextQuery_WithNoLoadOrderInBetween()
    {
        await Loaded();
        (await Client.Track(Plugin, Origin)).EnsureSuccessStatusCode();
        var formKey = await Client.FirstFormKey(Plugin);
        var before = await Client.Sequence();

        OtherTool.EditsASourceDocument(OtherTool.ModFolderOf(_instance, Origin), Plugin, Npc, "RenamedByHand");

        await Client.SequenceReaches(before + 1);
        Assert.Equal("RenamedByHand", (await Client.Record(formKey)).GetProperty("editorId").GetString());
    }
}
