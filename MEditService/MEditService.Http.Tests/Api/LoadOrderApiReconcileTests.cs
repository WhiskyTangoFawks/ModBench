using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

// ADR-0013 invariant 3: Mod Management states which plugins are active, and a plugin comes back in
// the load order exactly when the snapshot lists it as active.
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
}
