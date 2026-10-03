using System.Net;
using System.Net.Http.Json;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class LoadOrderApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;
    private readonly TestPluginFixture _fixture = loaded.Plugin;

    [Fact]
    public async Task PutLoadOrder_ScatteredPaths_Returns200AndLoadsPlugins()
    {
        using var fx = new PluginFixtureBuilder("api-explicit")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();

        var response = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Select(p => new { p.Name, p.Path, p.Origin }),
            active = SnapshotPlugins.Active(fx.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(fx.Plugins),
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var plugins = await _client.GetFromJsonAsync<List<dynamic>>("/plugins");
        Assert.NotNull(plugins);
        Assert.Equal(2, plugins.Count);
    }

    [Fact]
    public async Task PutLoadOrder_WithNoActiveField_Returns400()
    {
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = _fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin }),
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_WithNoLoadedWithNoLineField_Returns400()
    {
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = _fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin }),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // ADR-0012: the game loads one file per name.
    [Fact]
    public async Task PutLoadOrder_TwoActivePluginsOfOneFilename_Returns400()
    {
        var plugin = _fixture.Plugins[0];
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = new[] { new { plugin.Name, plugin.Path, plugin.Origin }, new { plugin.Name, plugin.Path, Origin = "OtherMod" } },
            active = new[] { new { name = plugin.Name, origin = plugin.Origin }, new { name = plugin.Name, origin = "OtherMod" } },
            loadedWithNoLine = Array.Empty<object>(),
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("OtherMod", await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task PutLoadOrder_MissingGameDirectory_Returns400()
    {
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = "/no-such-dir",
            instanceRoot = _fixture.InstanceRoot,
            plugins = Array.Empty<object>(),
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // ADR-0009: the instance root is what the index file is keyed on, so a load that cannot
    // name a real one has nowhere to keep its rows — a bad request, not a load that degrades to
    // some other home.
    [Fact]
    public async Task PutLoadOrder_MissingInstanceRoot_Returns400()
    {
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = "/no-such-instance",
            plugins = Array.Empty<object>(),
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
