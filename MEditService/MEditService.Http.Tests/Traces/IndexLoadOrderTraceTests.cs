using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

public sealed class IndexLoadOrderTraceTests : HostedTests
{
    private const string Plugin = "Projected.esp";
    private const string Origin = "ProjectedMod";
    private const string Npc = "ProjectedNpc";

    private static ScatteredFixtureData OneMod() =>
        new PluginFixtureBuilder("trace-project")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.5f, origin: Origin)
            .BuildScattered();

    [Fact]
    public async Task PuttingALoadOrder_ReportsReconcilingThenReady_AndTheRowsAnswerAfterwards()
    {
        using var fx = OneMod();
        using var stream = await Client.NotificationStream();

        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var status = await stream.EventsUntil(
            "load-order-status",
            e => e.GetProperty("loadOrderStatus").GetProperty("state").GetString() == "Ready");
        Assert.Contains(status, e => e.GetProperty("loadOrderStatus").GetProperty("state").GetString() == "Reconciling");
        var ready = status[^1].GetProperty("loadOrderStatus");
        Assert.True(ready.GetProperty("conflictsComputed").GetBoolean());

        var records = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&origin={Origin}&type=npc_");
        Assert.Equal(1, records.GetProperty("total").GetInt32());
    }

    [Fact]
    public async Task PuttingTheLoadOrderHeld_AnswersItsVersion_AndStartsNoReconcile()
    {
        using var fx = OneMod();
        var held = await VersionOf(await Client.PutLoadOrder(fx));
        using var stream = await Client.NotificationStream();

        var again = await VersionOf(await Client.PutLoadOrder(fx));
        var moved = await VersionOf(await Client.PutLoadOrder(fx, fx.Plugins.Select(p => p with { Enabled = false })));

        var statuses = (await stream.FramesThrough("load-order-status", d => StatusOf(d).GetProperty("version").GetInt64() == moved))
            .Where(f => f.Kind == "load-order-status")
            .Select(f => StatusOf(f.Data))
            .ToList();
        Assert.Equal("Reconciling", statuses[0].GetProperty("state").GetString());
        Assert.Equal(held, again);
    }

    [Fact]
    public async Task APluginWhosePluginSourceIsGone_IsTracked_ItsPluginSourceUnreadable_AndItsPluginFileAnswers()
    {
        using var fx = OneMod();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsTracked(Plugin);

        Directory.Delete(PluginSourceRoot.In(OtherTool.ModFolderOf(fx, Origin), Plugin), recursive: true);
        await Client.NextSnapshot(fx);

        await Wire.Eventually(
            async () => (await Client.Plugin(Plugin)).GetProperty("pluginSourceUnreadable").GetBoolean(),
            $"{Plugin} reported with its plugin source unreadable");
        Assert.True((await Client.Plugin(Plugin)).GetProperty("isTracked").GetBoolean());
        var records = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&origin={Origin}&type=npc_");
        Assert.Equal(1, records.GetProperty("total").GetInt32());
    }

    [Fact]
    public async Task ARecordFilterThatCannotApplyAgainAfterASnapshot_IsPushedClearedWithItsSourceAndReason()
    {
        using var fx = new PluginFixtureBuilder("trace-filter-cleared")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("7"), origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.PostAsJsonAsync(
            "/load-order/filter",
            new { sql = "SELECT form_key FROM npc_ WHERE CAST(editor_id AS INTEGER) = 7", source = "sevens.sql" }))
            .EnsureSuccessStatusCode();
        using var stream = await Client.NotificationStream();

        OtherTool.WritesThePlugin(fx.Plugins.Single(p => p.Origin == Origin).Path, mod => mod.Npcs.AddNew("NotANumber"));
        await Client.NextSnapshot(fx);

        var cleared = (await stream.EventsUntil("record-filter-cleared"))[^1].GetProperty("recordFilterCleared");
        Assert.Equal("sevens.sql", cleared.GetProperty("source").GetString());
        Assert.Contains("NotANumber", cleared.GetProperty("reason").GetString(), StringComparison.Ordinal);
    }

    private static async Task<long> VersionOf(HttpResponseMessage put) =>
        (await put.EnsureSuccessStatusCode().Content.ReadFromJsonAsync<JsonElement>()).GetProperty("version").GetInt64();

    private static JsonElement StatusOf(JsonElement frame) => frame.GetProperty("loadOrderStatus");
}
