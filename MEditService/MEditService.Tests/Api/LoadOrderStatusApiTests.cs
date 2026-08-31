using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>
/// <c>GET /load-order/status</c> is what the Plugins tree polls alongside the still-in-flight
/// load, so its no-load order answer matters as much as its loading one — a poller should not
/// have to read an error to learn that nothing is happening.
/// </summary>
public sealed class LoadOrderStatusApiTests : IDisposable
{
    private readonly WebApplicationFactory<Program> _app = new();
    private readonly HttpClient _client;

    public LoadOrderStatusApiTests() => _client = _app.CreateClient();

    [Fact]
    public async Task GetLoadOrderStatus_WithNoLoadOrder_Returns200AndStateNone()
    {
        var response = await _client.GetAsync(new Uri("/load-order/status", UriKind.Relative));

        // Not 503. Every other load-order-gated route answers 503 because it cannot do its job without
        // a load order; this one's job *is* to report that there is no load order.
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var status = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("None", status.GetProperty("state").GetString());
        Assert.False(status.GetProperty("conflictsComputed").GetBoolean());
        Assert.Empty(status.GetProperty("indexedPlugins").EnumerateArray());
    }

    [Fact]
    public async Task GetLoadOrderStatus_AfterALoad_ReportsReadyWithEveryPluginAndItsOrigin()
    {
        using var fx = new PluginFixtureBuilder("api-status")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .Build();

        var load = await _client.PutAsJsonAsync("/load-order", new
        {
            plugins = fx.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameDirectory = fx.DataFolder,
            instanceRoot = fx.InstanceRoot,
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();

        var status = await _client.GetFromJsonAsync<JsonElement>("/load-order/status");
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        Assert.True(status.GetProperty("conflictsComputed").GetBoolean());
        Assert.Equal(1, status.GetProperty("totalPlugins").GetInt32());

        var indexed = status.GetProperty("indexedPlugins").EnumerateArray().Single();
        Assert.Equal("A.esp", indexed.GetProperty("name").GetString());
        // (origin, plugin) is the identity (ADR-0036) — a status contract must not ship bare
        // filenames.
        Assert.False(string.IsNullOrWhiteSpace(indexed.GetProperty("origin").GetString()));
        Assert.Empty(status.GetProperty("failures").EnumerateArray());
    }

    [Fact]
    public async Task PutLoadOrder_StillReturnsOnlyOnceTheSweepHasRun()
    {
        using var fx = new PluginFixtureBuilder("api-status-contract")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .Build();

        var load = await _client.PutAsJsonAsync("/load-order", new
        {
            plugins = fx.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameDirectory = fx.DataFolder,
            instanceRoot = fx.InstanceRoot,
            gameRelease = "Fallout4",
        });

        // Loading is deliberately not asynchronous on the wire: the POST is still the
        // completion signal, and /load-order/status reports progress *alongside* it. If this ever
        // returns before the sweep, every caller that treats a 200 as "the load order is ready" —
        // including every existing test — silently starts reading unswept winners.
        Assert.Equal(HttpStatusCode.OK, load.StatusCode);
        var body = await load.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("reconciled", body.GetProperty("status").GetString());

        var status = await _client.GetFromJsonAsync<JsonElement>("/load-order/status");
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        Assert.True(status.GetProperty("conflictsComputed").GetBoolean());
    }

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
    }
}
