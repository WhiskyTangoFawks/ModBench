using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>Load-order status, track progress and external-change pending: the three status polls
/// the extension retired, proven end to end on the same SSE stream
/// <see cref="NotificationStreamApiTests"/> exercises for rows-changed.</summary>
[Collection(WebHostCollection.Name)]
public sealed class StatusNotificationStreamApiTests : IDisposable
{
    private readonly WebApplicationFactory<Program> _app = new();
    private readonly HttpClient _client;

    private const string Origin = "StatusNotifyMod";
    private const string Plugin = "StatusNotify.esp";

    public StatusNotificationStreamApiTests() => _client = _app.CreateClient();

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
    }

    private static ScatteredFixtureData BuildOneModOnePlugin() =>
        new PluginFixtureBuilder("api-status-notify")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("StatusNotifyNpc"), origin: Origin)
            .BuildScattered();

    private Task<HttpResponseMessage> PutLoadOrder(ScatteredFixtureData fx) =>
        _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Where(p => p.Origin == Origin)
                .Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        });

    // Reads frames of one kind until `isTerminal` matches one, bounded so a missed notification
    // fails the test instead of hanging the run. Frames of other kinds are skipped, not collected.
    private static async Task<List<JsonElement>> ReadEventsUntilAsync(
        StreamReader reader, string kind, Func<JsonElement, bool> isTerminal, TimeSpan timeout)
    {
        using var cts = new CancellationTokenSource(timeout);
        var collected = new List<JsonElement>();
        string? currentKind = null;
        while (true)
        {
            var line = await reader.ReadLineAsync(cts.Token);
            if (line is null) continue;
            if (line.StartsWith("event: ", StringComparison.Ordinal))
            {
                currentKind = line["event: ".Length..];
                continue;
            }
            if (!line.StartsWith("data: ", StringComparison.Ordinal)) continue;
            if (currentKind != kind) continue;

            var data = JsonDocument.Parse(line["data: ".Length..]).RootElement;
            collected.Add(data);
            if (isTerminal(data)) return collected;
        }
    }

    private async Task<StreamReader> OpenStreamAsync()
    {
        var response = await _client.GetAsync(
            new Uri("/notifications/stream", UriKind.Relative), HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();
        var stream = await response.Content.ReadAsStreamAsync();
        return new StreamReader(stream);
    }

    [Fact]
    public async Task PuttingALoadOrder_PublishesLoadOrderStatusNotifications_ReconcilingThroughToReady()
    {
        using var fx = BuildOneModOnePlugin();
        using var reader = await OpenStreamAsync();

        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var events = await ReadEventsUntilAsync(
            reader, "load-order-status",
            e => e.GetProperty("loadOrderStatus").GetProperty("state").GetString() == "Ready",
            TimeSpan.FromSeconds(10));

        Assert.Contains(events, e => e.GetProperty("loadOrderStatus").GetProperty("state").GetString() == "Reconciling");
        var ready = Assert.Single(events, e => e.GetProperty("loadOrderStatus").GetProperty("state").GetString() == "Ready");
        Assert.True(ready.GetProperty("loadOrderStatus").GetProperty("conflictsComputed").GetBoolean());
    }

    [Fact]
    public async Task TrackingAPlugin_PublishesTrackProgressNotifications_ForThatOrigin()
    {
        using var fx = BuildOneModOnePlugin();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        using var reader = await OpenStreamAsync();

        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" }))
            .EnsureSuccessStatusCode();

        var events = await ReadEventsUntilAsync(
            reader, "track-progress",
            e => e.GetProperty("trackProgress").GetProperty("phase").GetString() == "Idle",
            TimeSpan.FromSeconds(10));

        Assert.Contains(events, e => e.GetProperty("trackProgress").GetProperty("origin").GetString() == Origin);
        var last = events[^1];
        Assert.Equal("Idle", last.GetProperty("trackProgress").GetProperty("phase").GetString());
    }

    [Fact]
    public async Task AnExternalWriteToATrackedBinary_PublishesExternalChangePending()
    {
        using var fx = BuildOneModOnePlugin();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" }))
            .EnsureSuccessStatusCode();
        // Re-registers the plugin watcher now that the origin is tracked (ExternalChangeLoadOrderHook
        // runs on every PUT /load-order).
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        using var reader = await OpenStreamAsync();

        var pluginPath = fx.Plugins.First(p => p.Origin == Origin).Path;
        var changed = new Fallout4Mod(ModKey.FromFileName(Plugin), Fallout4Release.Fallout4);
        changed.Npcs.AddNew("ExternallyAddedNpc");
        changed.WriteToBinary(pluginPath);

        var events = await ReadEventsUntilAsync(reader, "external-change-pending", _ => true, TimeSpan.FromSeconds(10));

        var pending = Assert.Single(events);
        Assert.Equal(Plugin, pending.GetProperty("plugin").GetString());
        Assert.Equal(Origin, pending.GetProperty("origin").GetString());
    }
}
