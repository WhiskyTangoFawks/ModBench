using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

public sealed class DecompilePluginTraceTests : HostedTests
{
    private const string Plugin = "Tracked.esp";
    private const string Origin = "TrackedMod";
    private const string Npc = "TrackedNpc";
    private const string UntrackedOrigin = "UntrackedMod";

    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("trace-decompile-plugin")
        .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc), origin: Origin)
        .WithPlugin("Other.esp", mod => mod.Npcs.AddNew("OtherNpc"), origin: UntrackedOrigin)
        .BuildScattered();

    protected override void DisposeFixtures() => _instance.Dispose();

    private async Task Loaded() => (await Client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();

    [Fact]
    public async Task TrackingALoadedPlugin_AnswersItApplied_ReportsItsProgress_AndLeavesItEditable()
    {
        await Loaded();
        using var stream = await Client.NotificationStream();

        var tracked = await Client.Track(Origin);

        tracked.EnsureSuccessStatusCode();
        var body = await tracked.Content.ReadFromJsonAsync<JsonElement>();
        var applied = Assert.Single(body.GetProperty("applied").EnumerateArray());
        Assert.Equal((Plugin, Origin), (applied.GetProperty("name").GetString(), applied.GetProperty("origin").GetString()));
        Assert.Empty(body.GetProperty("refused").EnumerateArray());

        var progress = await stream.EventsUntil(
            "track-progress", e => e.GetProperty("trackProgress").GetProperty("phase").GetString() == "Idle");
        Assert.Contains(progress, e => e.GetProperty("trackProgress").GetProperty("origin").GetString() == Origin);

        var edit = await Client.Edit(await Client.FirstFormKey(Plugin, Origin), Plugin, Origin, "HeightMax", 0.75);
        edit.EnsureSuccessStatusCode();
        Assert.True((await edit.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("applied").GetBoolean());
    }

    [Fact]
    public async Task Tracking_MakesOneCommit_NamedForTheMod()
    {
        await Loaded();

        var tracked = await Client.Track(Origin);

        tracked.EnsureSuccessStatusCode();
        var modFolder = OtherTool.ModFolderOf(_instance, Origin);
        Assert.Equal(
            [$"Track {Path.GetFileName(modFolder)}"],
            GitProbe.Run(Path.Combine(modFolder, ".git"), modFolder, "log", "--format=%s", "main").Split('\n', StringSplitOptions.RemoveEmptyEntries));
    }

    [Fact]
    public async Task TrackingNoMod_Is400()
    {
        await Loaded();

        var response = await Client.Track([]);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task TrackingAModWithoutAName_Is400()
    {
        await Loaded();

        var response = await Client.Track(string.Empty);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task TrackingAModThatProvidesNoPlugin_RefusesTheSelection_Is404()
    {
        await Loaded();

        var response = await Client.Track([Origin, "NoSuchMod"]);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("ModProvidesNoPlugin", problem.GetProperty("refusal").GetString());
        Assert.Contains("NoSuchMod", problem.GetProperty("detail").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task DecompilingATrackedPluginWhoseBytesChanged_AnswersItApplied_AndItsNewSourceReachesTheAnswers()
    {
        await Loaded();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        var formKey = await Client.FirstFormKey(Plugin, Origin);
        OtherTool.WritesThePlugin(Path.Combine(OtherTool.ModFolderOf(_instance, Origin), Plugin), mod => mod.Npcs.AddNew("UpgradedNpc"));

        var decompiled = await Client.Decompile([(Plugin, Origin)]);

        decompiled.EnsureSuccessStatusCode();
        var body = await decompiled.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal([Plugin], body.GetProperty("applied").EnumerateArray().Select(p => p.GetProperty("name").GetString()));
        Assert.Empty(body.GetProperty("refused").EnumerateArray());
        await Client.NextSnapshot(_instance);
        var elapsed = System.Diagnostics.Stopwatch.StartNew();
        while ((await Client.Record(formKey)).GetProperty("editorId").GetString() != "UpgradedNpc")
        {
            Assert.True(elapsed.Elapsed < TimeSpan.FromSeconds(20), "The decompiled source never reached the answers.");
            await Task.Delay(50);
        }
    }

    [Fact]
    public async Task DecompilingAPluginInAModWithNoRepository_AnswersItRefused()
    {
        await Loaded();

        var response = await Client.Decompile([("Other.esp", UntrackedOrigin)]);

        response.EnsureSuccessStatusCode();
        var refused = Assert.Single((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refused").EnumerateArray());
        Assert.Equal("NotInTrackedMod", refused.GetProperty("refusal").GetString());
        Assert.Equal("Other.esp", refused.GetProperty("plugin").GetProperty("name").GetString());
    }

    [Fact]
    public async Task DecompilingNoPlugin_Is400()
    {
        await Loaded();

        var response = await Client.Decompile([]);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task AfterTrack_TheNextSnapshotReportsThePluginTracked()
    {
        await Loaded();
        Assert.False((await Client.Plugin(Plugin)).GetProperty("isTracked").GetBoolean());

        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(_instance);

        await Client.PluginReportsTracked(Plugin);
    }
}
