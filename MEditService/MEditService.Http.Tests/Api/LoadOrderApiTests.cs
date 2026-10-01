using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

[Collection(WebHostCollection.Name)]
public sealed class LoadOrderApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;
    private readonly TestPluginFixture _fixture = loaded.Plugin;

    [Fact]
    public async Task PutLoadOrder_Returns200AndLoadsPlugin()
    {
        var response = await _client.PutLoadOrderAndAwaitReady(new
        {
            plugins = _fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin }),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(_fixture.Plugins),
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var plugins = await _client.GetFromJsonAsync<List<dynamic>>("/plugins");
        Assert.NotNull(plugins);
        Assert.Single(plugins);
    }

    [Fact]
    public async Task PutLoadOrder_ThenGetRecords_ReturnsIndexedRecords()
    {
        var load = await _client.PutLoadOrderAndAwaitReady(new
        {
            plugins = _fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin }),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(_fixture.Plugins),
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();

        var records = await _client.GetFromJsonAsync<JsonElement>($"/records?type=npc_&limit=10");

        // The loaded plugin's NPC records were actually indexed and are queryable.
        Assert.True(records.GetProperty("total").GetInt32() > 0);
    }

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
    public async Task PutLoadOrder_UnparseablePlugin_LoadsRestAndReportsFailure()
    {
        using var fx = new PluginFixtureBuilder("api-explicit-bad")
            .WithPlugin("Good.esp", mod => mod.Npcs.AddNew("GoodNpc"))
            .BuildScattered();
        var badPath = System.IO.Path.Combine(fx.Root, "Bad.esp");
        await System.IO.File.WriteAllTextAsync(badPath, "this is not a plugin");

        var plugins = fx.Plugins.Append(new LoadOrderEntry("Bad.esp", badPath, PluginOrigin.DataDirectory, Slot: 99, Enabled: true, Winning: true));

        var response = await _client.PutLoadOrderAndAwaitReady(SnapshotPlugins.Body(fx.GameDirectory, fx.InstanceRoot, plugins));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var status = await _client.GetFromJsonAsync<LoadOrderStatusDto>("/load-order/status");
        Assert.NotNull(status);
        var failure = Assert.Single(status.Failures);
        Assert.Equal("Bad.esp", failure.Name);
    }

    // ADR-0013: two plugins that share a filename are two rows, so a failure that named only the
    // file would land on whichever row the reader looked up first.
    [Fact]
    public async Task PutLoadOrder_OverriddenPluginUnparseable_TheFailureNamesTheOverriddenPluginsOrigin()
    {
        using var fx = new PluginFixtureBuilder("api-overridden-plugin-bad")
            .WithPlugin("Shared.esp", origin: "ModB")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .BuildScattered();
        var winner = fx.Plugins.Single(p => p.Origin == "ModA");
        var overridden = fx.Plugins.Single(p => p.Origin == "ModB");
        await System.IO.File.WriteAllTextAsync(overridden.Path, "this is not a plugin");

        var response = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = new[] { winner, overridden }.Select(p => new { p.Name, p.Path, p.Origin }),
            active = SnapshotPlugins.Active(new[] { winner, overridden }),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(new[] { winner, overridden }),
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var status = await _client.GetFromJsonAsync<LoadOrderStatusDto>("/load-order/status");
        Assert.NotNull(status);
        var failure = Assert.Single(status.Failures);
        Assert.Equal("Shared.esp", failure.Name);
        Assert.Equal("ModB", failure.Origin);
    }

    private sealed record LoadOrderStatusDto(IReadOnlyList<PluginLoadFailureDto> Failures);
    private sealed record PluginLoadFailureDto(string Name, string Origin, string Reason);

    // ADR-0013 invariant 3: which plugins are active is Mod Management's to state.
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

    [Fact]
    public async Task PutLoadOrder_APluginLoadedWithNoLineThatIsNoPluginInTheSnapshot_Returns400()
    {
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = _fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin }),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            loadedWithNoLine = new[] { new { name = "Fallout4.esm", origin = "Data" } },
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("Fallout4.esm", await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task PutLoadOrder_AnActivePluginThatIsNoPluginInTheSnapshot_Returns400()
    {
        var response = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            plugins = _fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin }),
            active = new[] { new { name = "Stray.esp", origin = "StrayMod" } },
            loadedWithNoLine = Array.Empty<object>(),
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("Stray.esp", await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);
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
