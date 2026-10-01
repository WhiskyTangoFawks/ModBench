using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Http.Tests.Api;

// ADR-0013 invariant 3: Mod Management states which plugins are active, and a plugin comes back in
// the load order exactly when the snapshot lists it as active.
[Collection(WebHostCollection.Name)]
public sealed class LoadOrderApiReconcileTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private Task<HttpResponseMessage> Put(ScatteredFixtureData fx, IEnumerable<LoadOrderEntry> plugins) =>
        _client.PutLoadOrderAndAwaitReady(SnapshotPlugins.Body(fx.GameDirectory, fx.InstanceRoot, plugins));

    [Fact]
    public async Task PutLoadOrder_APluginTheSnapshotDoesNotListAsActive_ComesBackOutsideTheLoadOrder_ReadOnly()
    {
        using var fx = new PluginFixtureBuilder("api-reconcile-disabled")
            .WithPlugin("Active.esp", mod => mod.Npcs.AddNew("FromActive"))
            .WithPlugin("Dormant.esp", mod => mod.Npcs.AddNew("FromDormant"), enabled: false)
            .BuildScattered();

        var response = await Put(fx, fx.Plugins);
        response.EnsureSuccessStatusCode();
        Assert.True((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("applied").GetBoolean());

        var plugins = await _client.GetFromJsonAsync<JsonElement>("/plugins");
        var byName = plugins.EnumerateArray().ToDictionary(p => DocumentNodes.StringValueOf(p.GetProperty("name")));
        Assert.True(byName["Active.esp"].GetProperty("inLoadOrder").GetBoolean());
        Assert.False(byName["Dormant.esp"].GetProperty("inLoadOrder").GetBoolean());
        Assert.Equal(JsonValueKind.Null, byName["Dormant.esp"].GetProperty("loadOrderIndex").ValueKind);
        Assert.True(byName["Dormant.esp"].GetProperty("isImmutable").GetBoolean());
    }

    [Fact]
    public async Task PutLoadOrder_UnlistedPlugin_HasNoSlot_AndIsNotInTheLoadOrder()
    {
        using var fx = new PluginFixtureBuilder("api-reconcile-unlisted")
            .WithPlugin("Listed.esp")
            .WithPlugin("Stray.esp")
            .BuildScattered();
        var plugins = fx.Plugins.Select(p => p.Name == "Stray.esp" ? p with { Slot = null } : p);

        var response = await Put(fx, plugins);
        response.EnsureSuccessStatusCode();

        var stray = (await _client.GetFromJsonAsync<JsonElement>("/plugins")).EnumerateArray()
            .Single(p => p.GetProperty("name").GetString() == "Stray.esp");
        Assert.Equal(JsonValueKind.Null, stray.GetProperty("loadOrderIndex").ValueKind);
        Assert.False(stray.GetProperty("inLoadOrder").GetBoolean());
        Assert.True(stray.GetProperty("isImmutable").GetBoolean());
    }

    [Fact]
    public async Task PutLoadOrder_TwiceIdentical_StaysReadyWithConflictsComputed()
    {
        using var fx = new PluginFixtureBuilder("api-reconcile-idempotent")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();
        (await Put(fx, fx.Plugins)).EnsureSuccessStatusCode();
        (await Put(fx, fx.Plugins)).EnsureSuccessStatusCode();

        var status = await _client.GetFromJsonAsync<JsonElement>("/load-order/status");
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        Assert.True(status.GetProperty("conflictsComputed").GetBoolean());
    }

    // ADR-0012: a missing master is detection and display (MasterResolution), never a
    // deactivation — an active plugin with a missing master keeps competing for winner exactly as
    // it would without the flag.
    [Fact]
    public async Task PutLoadOrder_ActivePluginWithMissingMaster_StaysActive()
    {
        using var fx = new PluginFixtureBuilder("api-reconcile-missing-master")
            .WithPlugin("Patch.esp", mod => mod.Npcs.AddNew("PatchedNpc").Race.SetTo(
                new FormKey(ModKey.FromFileName("Ghost.esm"), 0x800)))
            .BuildScattered();

        var response = await Put(fx, fx.Plugins);
        response.EnsureSuccessStatusCode();

        var patch = (await _client.GetFromJsonAsync<JsonElement>("/plugins")).EnumerateArray()
            .Single(p => p.GetProperty("name").GetString() == "Patch.esp");
        Assert.True(patch.GetProperty("inLoadOrder").GetBoolean());
        Assert.NotEmpty(patch.GetProperty("masterIssues").EnumerateArray());
    }
}
