using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Core.Session;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Api;

public sealed class SessionApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;
    private readonly TestPluginFixture _fixture = loaded.Plugin;

    [Fact]
    public async Task PostSessionLoadExplicit_Returns200AndLoadsPlugin()
    {
        var response = await _client.PostAsJsonAsync("/session/load-explicit", new
        {
            plugins = _fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Participates }),
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
    public async Task PostSessionLoadExplicit_ThenGetRecords_ReturnsIndexedRecords()
    {
        var load = await _client.PostAsJsonAsync("/session/load-explicit", new
        {
            plugins = _fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Participates }),
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
    public async Task PostSessionLoadExplicit_ScatteredPaths_Returns200AndLoadsPlugins()
    {
        using var fx = new PluginFixtureBuilder("api-explicit")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();

        var response = await _client.PostAsJsonAsync("/session/load-explicit", new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Select(p => new { name = p.Name, path = p.Path, origin = p.Origin, participates = p.Participates }),
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var plugins = await _client.GetFromJsonAsync<List<dynamic>>("/plugins");
        Assert.NotNull(plugins);
        Assert.Equal(2, plugins.Count);
    }

    [Fact]
    public async Task PostSessionLoadExplicit_UnparseablePlugin_LoadsRestAndReportsFailure()
    {
        using var fx = new PluginFixtureBuilder("api-explicit-bad")
            .WithPlugin("Good.esp", mod => mod.Npcs.AddNew("GoodNpc"))
            .BuildScattered();
        var badPath = System.IO.Path.Combine(fx.Root, "Bad.esp");
        await System.IO.File.WriteAllTextAsync(badPath, "this is not a plugin");

        var plugins = fx.Plugins.Append(new ExplicitPluginInput("Bad.esp", badPath, PluginOrigin.DataDirectory, true))
            .Select(p => new { name = p.Name, path = p.Path, origin = p.Origin, participates = p.Participates });

        var response = await _client.PostAsJsonAsync("/session/load-explicit", new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins,
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<SessionLoadResponseDto>();
        Assert.NotNull(body);
        var failure = Assert.Single(body!.Failures);
        Assert.Equal("Bad.esp", failure.Name);
    }

    private sealed record SessionLoadResponseDto(string Status, IReadOnlyList<PluginLoadFailureDto> Failures);
    private sealed record PluginLoadFailureDto(string Name, string Reason);

    [Fact]
    public async Task PostSessionLoadExplicit_MissingGameDirectory_Returns400()
    {
        var response = await _client.PostAsJsonAsync("/session/load-explicit", new
        {
            gameDirectory = "/no-such-dir",
            instanceRoot = _fixture.InstanceRoot,
            plugins = Array.Empty<object>(),
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // #592 / ADR-0001: the instance root is what the index file is keyed on, so a load that cannot
    // name a real one has nowhere to keep its rows — a bad request, not a load that degrades to
    // some other home.
    [Fact]
    public async Task PostSessionLoadExplicit_MissingInstanceRoot_Returns400()
    {
        var response = await _client.PostAsJsonAsync("/session/load-explicit", new
        {
            gameDirectory = _fixture.DataFolder,
            instanceRoot = "/no-such-instance",
            plugins = Array.Empty<object>(),
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
