using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>
/// #274: <c>GET /session/status</c> is what the Plugins tree polls alongside the still-in-flight
/// load (#307), so its no-session answer matters as much as its loading one — a poller should not
/// have to read an error to learn that nothing is happening.
/// </summary>
public sealed class SessionStatusApiTests : IDisposable
{
    private readonly WebApplicationFactory<Program> _app = new();
    private readonly HttpClient _client;

    public SessionStatusApiTests() => _client = _app.CreateClient();

    [Fact]
    public async Task GetSessionStatus_WithNoSession_Returns200AndStateNone()
    {
        var response = await _client.GetAsync(new Uri("/session/status", UriKind.Relative));

        // Not 503. Every other session-gated route answers 503 because it cannot do its job without
        // a session; this one's job *is* to report that there is no session.
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var status = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("None", status.GetProperty("state").GetString());
        Assert.False(status.GetProperty("conflictsComputed").GetBoolean());
        Assert.Empty(status.GetProperty("indexedPlugins").EnumerateArray());
    }

    [Fact]
    public async Task GetSessionStatus_AfterALoad_ReportsReadyWithEveryPluginAndItsOrigin()
    {
        using var fx = new PluginFixtureBuilder("api-status")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .Build();

        var load = await _client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = fx.DataFolder,
            pluginsTxtPath = fx.PluginsTxtPath,
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();

        var status = await _client.GetFromJsonAsync<JsonElement>("/session/status");
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        Assert.True(status.GetProperty("conflictsComputed").GetBoolean());
        Assert.Equal(1, status.GetProperty("totalPlugins").GetInt32());

        var indexed = status.GetProperty("indexedPlugins").EnumerateArray().Single();
        Assert.Equal("A.esp", indexed.GetProperty("name").GetString());
        // (origin, plugin) is the identity (#271 / #275) — a status contract shipping bare filenames
        // would reintroduce what four tickets removed.
        Assert.False(string.IsNullOrWhiteSpace(indexed.GetProperty("origin").GetString()));
        Assert.Empty(status.GetProperty("failures").EnumerateArray());
    }

    [Fact]
    public async Task PostSessionLoad_StillReturnsOnlyOnceTheSweepHasRun()
    {
        using var fx = new PluginFixtureBuilder("api-status-contract")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .Build();

        var load = await _client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = fx.DataFolder,
            pluginsTxtPath = fx.PluginsTxtPath,
            gameRelease = "Fallout4",
        });

        // #274 deliberately did not make loading asynchronous on the wire: the POST is still the
        // completion signal, and /session/status reports progress *alongside* it. If this ever
        // returns before the sweep, every caller that treats a 200 as "the session is ready" —
        // including every existing test — silently starts reading unswept winners.
        Assert.Equal(HttpStatusCode.OK, load.StatusCode);
        var body = await load.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("loaded", body.GetProperty("status").GetString());

        var status = await _client.GetFromJsonAsync<JsonElement>("/session/status");
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        Assert.True(status.GetProperty("conflictsComputed").GetBoolean());
    }

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
    }
}
