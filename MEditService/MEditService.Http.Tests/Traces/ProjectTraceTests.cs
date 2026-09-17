using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Traces;

/// <summary>project: the snapshot arrives, the Projector reconciles it against what the plugins
/// actually hold, and the Store announces what changed — so the client sees status, then a
/// rows-changed push, then its own re-read.</summary>
[Collection(WebHostCollection.Name)]
public sealed class ProjectTraceTests : HostedTests
{
    private const string Plugin = "Projected.esp";
    private const string Origin = "ProjectedMod";
    private const string Npc = "ProjectedNpc";

    private static ScatteredFixtureData OneMod() =>
        new PluginFixtureBuilder("trace-project")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.5f, origin: Origin)
            .BuildScattered();

    private Task<HttpResponseMessage> Reconcile(string? query = null) =>
        Client.PostAsync(new Uri($"/index/reconcile{query}", UriKind.Relative), content: null);

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

        var records = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&type=npc_");
        Assert.Equal(1, records.GetProperty("total").GetInt32());
    }

    // A binary has no smaller unit than itself, so the copy the reconcile names is re-derived whole
    // rather than by key.
    [Fact]
    public async Task ReconcilingOnePlugin_RederivesTheCopyWhoseBytesMoved_AndTheAnswerFollows()
    {
        using var fx = OneMod();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        var formKey = await Client.FirstFormKey(Plugin);
        var before = await Client.Sequence();

        OtherTool.WritesThePlugin(
            fx.Plugins.Single(p => p.Origin == Origin).Path, mod => mod.Npcs.AddNew(Npc).HeightMax = 0.9f);
        Assert.NotEqual(0.9, await HeightMaxOf(formKey), 3);

        var reconciled = await Reconcile($"?plugin={Plugin}&origin={Origin}");

        reconciled.EnsureSuccessStatusCode();
        var body = await reconciled.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1, body.GetProperty("plugins").GetInt32());
        Assert.Equal(1, body.GetProperty("pluginsRebuilt").GetInt32());
        Assert.True(body.GetProperty("sequence").GetInt64() > before);

        Assert.Equal(0.9, await HeightMaxOf(formKey), 3);
    }

    private async Task<double> HeightMaxOf(string formKey) =>
        (await Client.Record(formKey)).GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == "HeightMax")
            .GetProperty("value").GetDouble();

    [Fact]
    public async Task ReconcilingEveryPlugin_ReportsHowManyCopiesItCheckedAndHowManyRowsChanged()
    {
        using var fx = OneMod();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var reconciled = await Reconcile();

        reconciled.EnsureSuccessStatusCode();
        var body = await reconciled.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.GetProperty("plugins").GetInt32() >= 1);
        Assert.Equal(0, body.GetProperty("rowsChanged").GetInt32());
        Assert.Empty(body.GetProperty("failures").EnumerateArray());
    }

    [Fact]
    public async Task ReconcilingACopyTheLoadOrderDoesNotHold_Is404()
    {
        using var fx = OneMod();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var reconciled = await Reconcile("?plugin=NoSuch.esp&origin=Nowhere");

        Assert.Equal(HttpStatusCode.NotFound, reconciled.StatusCode);
    }

    [Fact]
    public async Task ReconcilingAPluginWithoutNamingItsOrigin_Is400()
    {
        using var fx = OneMod();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var reconciled = await Reconcile($"?plugin={Plugin}");

        Assert.Equal(HttpStatusCode.BadRequest, reconciled.StatusCode);
    }
}
