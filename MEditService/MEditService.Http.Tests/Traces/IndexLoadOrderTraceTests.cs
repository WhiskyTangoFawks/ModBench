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
    public async Task ARecordFilterThatCannotApplyAgainAfterASnapshot_IsToldAsEverythingChanged_AndReadClearedWithItsSourceAndReason()
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
        await Client.NextCheck(fx);

        await stream.EventsUntil("record-index-changed");
        var cleared = await Client.GetFromJsonAsync<JsonElement>("/load-order/filter/cleared");
        Assert.Equal("sevens.sql", cleared.GetProperty("source").GetString());
        Assert.Contains("NotANumber", cleared.GetProperty("reason").GetString(), StringComparison.Ordinal);
    }

}
