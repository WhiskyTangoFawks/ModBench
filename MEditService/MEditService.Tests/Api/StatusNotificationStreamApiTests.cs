using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Source;
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

    // ADR-0046: one watcher per mod routes all three signals — a hand edit under source, a commit
    // moving HEAD, and a plugin overwrite — to the seams they reach today, in one pass over the
    // same temporary tracked mod.
    [Fact]
    public async Task AHandEditThenACommitThenAPluginOverwrite_EachReachTheSameSeam()
    {
        using var fx = BuildOneModOnePlugin();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" }))
            .EnsureSuccessStatusCode();
        // Re-registers the plugin watcher now that the origin is tracked (ExternalChangeLoadOrderHook
        // runs on every PUT /load-order).
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var pluginPath = fx.Plugins.First(p => p.Origin == Origin).Path;
        var modFolder = Path.GetDirectoryName(pluginPath)!;
        var records = await _client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&type=npc_");
        var formKey = records.GetProperty("items")[0].GetProperty("formKey").GetString()!;
        var sourceFile = Directory
            .EnumerateFiles(Path.Combine(modFolder, "source", Plugin), "*.json", SearchOption.AllDirectories)
            .Single(f => !Path.GetFileName(f).StartsWith("RecordData", StringComparison.Ordinal)
                         && !Path.GetFileName(f).StartsWith("GroupRecordData", StringComparison.Ordinal));

        using var reader = await OpenStreamAsync();

        // A hand edit under the source folder refreshes the Index by key, as it does today.
        var text = File.ReadAllText(sourceFile);
        File.WriteAllText(sourceFile, text.Replace("StatusNotifyNpc", "HandEditedNpc", StringComparison.Ordinal));
        var handEdits = await ReadEventsUntilAsync(
            reader, "rows-changed",
            e => e.GetProperty("keys").EnumerateArray().Any(k => k.GetString() == formKey),
            TimeSpan.FromSeconds(10));
        Assert.Contains(handEdits, e => e.GetProperty("plugin").GetString() == Plugin);

        // A commit that moves HEAD refreshes the committed view whole, as it does today: a fresh
        // projection lands, provable through the same sequence-await the extension itself polls.
        var beforeCommit = await _client.GetFromJsonAsync<long>("/load-order/sequence");
        var gitDir = Path.Combine(modFolder, ".git");
        GitCli.Run(gitDir, modFolder, "add", "-A");
        GitCli.Run(gitDir, modFolder, "commit", "-q", "-m", "hand edit committed outside Modbench");
        var afterCommit = await _client.GetFromJsonAsync<SequenceAwaitResponse>(
            $"/load-order/sequence/await?atLeast={beforeCommit + 1}&timeoutMs=10000");
        Assert.True(afterCommit!.Reached, "the commit's ref move never landed a fresh projection");

        // A plugin overwrite reaches the classifier's external-change route, as it does today.
        var changedPlugin = new Fallout4Mod(ModKey.FromFileName(Plugin), Fallout4Release.Fallout4);
        changedPlugin.Npcs.AddNew("ExternallyAddedNpc");
        changedPlugin.WriteToBinary(pluginPath);
        var pending = await ReadEventsUntilAsync(reader, "external-change-pending", _ => true, TimeSpan.FromSeconds(10));

        var one = Assert.Single(pending);
        Assert.Equal(Plugin, one.GetProperty("plugin").GetString());
        Assert.Equal(Origin, one.GetProperty("origin").GetString());
    }
}
