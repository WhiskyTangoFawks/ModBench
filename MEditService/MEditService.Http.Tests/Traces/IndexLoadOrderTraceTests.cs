using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

/// <summary>index-load-order: the snapshot arrives, the Indexer reconciles it against what the
/// plugins actually hold, and the Store announces what changed — so the client sees status, then
/// a rows-changed push, then its own re-read.</summary>
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

    // ADR-0013 invariant 1: an identical snapshot does nothing. Every reconcile ends by publishing
    // its status, so a reconcile the identical PUT started would publish before the moved one opens.
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

    private static async Task<long> VersionOf(HttpResponseMessage put) =>
        (await put.EnsureSuccessStatusCode().Content.ReadFromJsonAsync<JsonElement>()).GetProperty("version").GetInt64();

    private static JsonElement StatusOf(JsonElement frame) => frame.GetProperty("loadOrderStatus");
}
