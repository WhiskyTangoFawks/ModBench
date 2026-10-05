using System.Net;
using System.Net.Http.Json;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
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
            plugins = fx.Plugins.Select(p => p.Wire),
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
    public async Task PutLoadOrder_ReadsWhatProvidesAPluginFromTheSnapshot_NotFromThePluginsDirectory()
    {
        using var fx = new PluginFixtureBuilder("api-provider")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"), origin: "ModA")
            .BuildScattered();
        var named = new PluginProvider.FromMod("ModA", Path.Combine(fx.InstanceRoot, "mods", "ModA"));
        var plugins = fx.Plugins.Select(p => p with { NamedProvider = named }).ToList();

        var response = await _client.PutLoadOrderAndAwaitReady(SnapshotPlugins.Body(fx.GameDirectory, fx.InstanceRoot, plugins));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var held = loaded.Services.GetRequiredService<LoadOrderHolder>().Current;
        Assert.Equal(named, held.ProviderOf(new PluginAddress("A.esp", "ModA")));
    }

    [Theory]
    [InlineData("Game", "ModA", null)]
    [InlineData("None", null, "/mods/ModA")]
    [InlineData("Mod", "ModA", null)]
    [InlineData("Mod", null, "/mods/ModA")]
    public async Task PutLoadOrder_AProviderWhoseModAndFolderDisagreeWithItsKind_Returns400(string kind, string? mod, string? folder)
    {
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = _fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin, Provider = new { Kind = kind, Mod = mod, Folder = folder } }),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(_fixture.Plugins),
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_APluginWithNoProvider_Returns400()
    {
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = _fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin }),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(_fixture.Plugins),
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_WithNoActiveField_Returns400()
    {
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = _fixture.Plugins.Select(p => p.Wire),
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
            plugins = _fixture.Plugins.Select(p => p.Wire),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_WithNoGameRelease_Returns400()
    {
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = _fixture.Plugins.Select(p => p.Wire),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(_fixture.Plugins),
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_TwoActivePluginsOfOneFilename_Returns400()
    {
        var plugin = _fixture.Plugins[0];
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = new[] { plugin.Wire, (plugin with { Origin = "OtherMod" }).Wire },
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
