using System.Net.Http.Json;
using System.Text.Json;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class LoadOrderApiOriginTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    [Fact]
    public async Task PutLoadOrder_PluginWithOrigin_OriginRoundTripsToGetPlugins()
    {
        using var fx = new PluginFixtureBuilder("api-explicit-origin")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();

        var response = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Select(p => (p with { Origin = "SomeMod" }).Wire),
            active = SnapshotPlugins.Active(fx.Plugins.Select(p => p with { Origin = "SomeMod" })),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(fx.Plugins.Select(p => p with { Origin = "SomeMod" })),
            gameRelease = "Fallout4",
        });
        response.EnsureSuccessStatusCode();

        var plugins = await _client.GetFromJsonAsync<JsonElement>("/plugins");
        var plugin = plugins.EnumerateArray().Single(p => p.GetProperty("name").GetString() == "A.esp");
        Assert.Equal("SomeMod", plugin.GetProperty("origin").GetString());
    }
}
