using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Mvc.Testing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>The Plugins tree polls this alongside an in-flight load, so the no-load-order answer
/// matters as much as the loading one: a poller should not read an error to learn nothing is
/// happening.</summary>
[Collection(WebHostCollection.Name)]
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

        var load = await _client.PutLoadOrderAndAwaitReady(new
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
        // (origin, plugin) is the identity (ADR-0012) — a status contract must not ship bare
        // filenames.
        Assert.False(string.IsNullOrWhiteSpace(indexed.GetProperty("origin").GetString()));
        Assert.Empty(status.GetProperty("failures").EnumerateArray());
    }

    // Applied answers as soon as the snapshot lands, never once the sweep has run — the sweep is
    // Load order state's own progress, learned by polling or subscribing status, not the PUT.
    [Fact]
    public async Task PutLoadOrder_AnswersAppliedAtOnce_AndStatusReachesReadySeparately()
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

        Assert.Equal(HttpStatusCode.OK, load.StatusCode);
        var body = await load.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.GetProperty("applied").GetBoolean());

        await _client.AwaitTerminalLoadOrderStatus(beforeSequence: 0);
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
