using System.Net.Http.Json;
using System.Text.Json;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Api;

// #269 / ADR-0036: the wire contract's Origin round-trip — a caller-supplied ExplicitPlugin.Origin
// travels through /load-order and back out on GET /plugins.
public sealed class LoadOrderApiOriginTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    [Fact]
    public async Task PutLoadOrder_PluginWithOrigin_OriginRoundTripsToGetPlugins()
    {
        using var fx = new PluginFixtureBuilder("api-explicit-origin")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();

        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Select(p => new { p.Name, p.Path, Origin = "SomeMod", p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        });
        response.EnsureSuccessStatusCode();

        var plugins = await _client.GetFromJsonAsync<JsonElement>("/plugins");
        var plugin = plugins.EnumerateArray().Single(p => p.GetProperty("name").GetString() == "A.esp");
        Assert.Equal("SomeMod", plugin.GetProperty("origin").GetString());
    }
}
