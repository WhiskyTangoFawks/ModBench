using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http;
using MEditService.SourceRepo;
using Microsoft.AspNetCore.Mvc.Testing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>Load-order status, track progress and a question open: the three status polls
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

    private Task<HttpResponseMessage> PutLoadOrder(ScatteredFixtureData fx, HttpClient? client = null) =>
        (client ?? _client).PutAsJsonAsync("/load-order", new
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

    private async Task<StreamReader> OpenStreamAsync(HttpClient? client = null)
    {
        var response = await (client ?? _client).GetAsync(
            new Uri("/notifications/stream", UriKind.Relative), HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();
        var stream = await response.Content.ReadAsStreamAsync();
        return new StreamReader(stream);
    }

    // A negative assertion: nothing of this kind arrives within `window`, which must exceed the
    // watcher's quiet window so a wrongly-fired notification has had time to land.
    private static async Task AssertNoExternalChangeAsync(StreamReader reader, TimeSpan window)
    {
        await Assert.ThrowsAsync<OperationCanceledException>(
            () => ReadEventsUntilAsync(reader, "question-open", _ => true, window));
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
    public async Task AnExternalWriteToATrackedBinary_PublishesQuestionOpen()
    {
        using var fx = BuildOneModOnePlugin();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" }))
            .EnsureSuccessStatusCode();
        // Re-arms the watcher now that the origin is tracked: PUT /load-order hands the watcher
        // the value it just put.
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        using var reader = await OpenStreamAsync();

        var pluginPath = fx.Plugins.First(p => p.Origin == Origin).Path;
        var changed = new Fallout4Mod(ModKey.FromFileName(Plugin), Fallout4Release.Fallout4);
        changed.Npcs.AddNew("ExternallyAddedNpc");
        changed.WriteToBinary(pluginPath);

        var events = await ReadEventsUntilAsync(reader, "question-open", _ => true, TimeSpan.FromSeconds(10));

        var pending = Assert.Single(events);
        Assert.Contains(Plugin, pending.GetProperty("keys").EnumerateArray().Select(k => k.GetString()));
        Assert.Equal(Origin, pending.GetProperty("origin").GetString());
    }

    // ADR-0014: one watcher per mod routes all three signals — a hand edit under source, a commit
    // moving HEAD, and a plugin overwrite — to the seams they reach today, in one pass over the
    // same temporary tracked mod.
    [Fact]
    public async Task AHandEditThenACommitThenAPluginOverwrite_EachReachTheSameSeam()
    {
        using var fx = BuildOneModOnePlugin();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" }))
            .EnsureSuccessStatusCode();
        // Re-arms the watcher now that the origin is tracked: PUT /load-order hands the watcher
        // the value it just put.
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
        var pending = await ReadEventsUntilAsync(reader, "question-open", _ => true, TimeSpan.FromSeconds(10));

        var one = Assert.Single(pending);
        Assert.Contains(Plugin, one.GetProperty("keys").EnumerateArray().Select(k => k.GetString()));
        Assert.Equal(Origin, one.GetProperty("origin").GetString());
    }

    // ── The mod-level classifier: git's view of tracked files, meta.ini the tell. ──

    [Fact]
    public async Task AChangedAssetUnderEverything_PublishesQuestionOpen_NamingThePath()
    {
        using var fx = BuildOneModOnePlugin();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        var modFolder = Path.GetDirectoryName(fx.Plugins.First(p => p.Origin == Origin).Path)!;
        File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "original");

        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Everything" }))
            .EnsureSuccessStatusCode();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        using var reader = await OpenStreamAsync();

        File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "changed-by-the-release");

        var events = await ReadEventsUntilAsync(reader, "question-open", _ => true, TimeSpan.FromSeconds(10));

        var pending = Assert.Single(events);
        Assert.Empty(pending.GetProperty("keys").EnumerateArray());
        Assert.Contains("texture.dds",
            pending.GetProperty("externalChangeTrackedFiles").EnumerateArray().Select(k => k.GetString()));
    }

    [Fact]
    public async Task TheSameAssetChangeUnderEdits_PublishesNothing()
    {
        using var fx = BuildOneModOnePlugin();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        var modFolder = Path.GetDirectoryName(fx.Plugins.First(p => p.Origin == Origin).Path)!;
        File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "original");

        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" }))
            .EnsureSuccessStatusCode();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        using var reader = await OpenStreamAsync();

        File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "changed-by-the-release");

        await AssertNoExternalChangeAsync(reader, TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task AMetaIniVersionEditAlone_PublishesNothing()
    {
        using var fx = BuildOneModOnePlugin();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        var modFolder = Path.GetDirectoryName(fx.Plugins.First(p => p.Origin == Origin).Path)!;
        File.WriteAllText(Path.Combine(modFolder, "meta.ini"), "version=1.0.0\n");

        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" }))
            .EnsureSuccessStatusCode();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        using var reader = await OpenStreamAsync();

        File.WriteAllText(Path.Combine(modFolder, "meta.ini"), "version=2.0.0\n");

        await AssertNoExternalChangeAsync(reader, TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task AMetaIniVersionEditThenAPluginWrite_PublishesOneWithTheTellAndBothVersions()
    {
        using var fx = BuildOneModOnePlugin();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        var pluginPath = fx.Plugins.First(p => p.Origin == Origin).Path;
        var modFolder = Path.GetDirectoryName(pluginPath)!;
        File.WriteAllText(Path.Combine(modFolder, "meta.ini"), "version=1.0.0\n");

        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" }))
            .EnsureSuccessStatusCode();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        using var reader = await OpenStreamAsync();

        File.WriteAllText(Path.Combine(modFolder, "meta.ini"), "version=2.0.0\n");
        var changed = new Fallout4Mod(ModKey.FromFileName(Plugin), Fallout4Release.Fallout4);
        changed.Npcs.AddNew("ExternallyAddedNpc");
        changed.WriteToBinary(pluginPath);

        var events = await ReadEventsUntilAsync(reader, "question-open", _ => true, TimeSpan.FromSeconds(10));

        var pending = Assert.Single(events);
        Assert.True(pending.GetProperty("externalChangeMetaChanged").GetBoolean());
        Assert.Equal("1.0.0", pending.GetProperty("externalChangeOldVersion").GetString());
        Assert.Equal("2.0.0", pending.GetProperty("externalChangeNewVersion").GetString());
    }

    // A release-sized burst — many assets plus the plugin — settles as one window and one question.
    [Fact]
    public async Task AReleaseThatTouchesManyFilesInOneWindow_PublishesExactlyOneNotification()
    {
        using var fx = BuildOneModOnePlugin();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        var pluginPath = fx.Plugins.First(p => p.Origin == Origin).Path;
        var modFolder = Path.GetDirectoryName(pluginPath)!;
        var assetNames = Enumerable.Range(0, 20).Select(i => $"asset{i:D2}.dds").ToList();
        foreach (var name in assetNames) File.WriteAllText(Path.Combine(modFolder, name), "original");

        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Everything" }))
            .EnsureSuccessStatusCode();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        using var reader = await OpenStreamAsync();

        foreach (var name in assetNames) File.WriteAllText(Path.Combine(modFolder, name), "changed-by-the-release");
        var changed = new Fallout4Mod(ModKey.FromFileName(Plugin), Fallout4Release.Fallout4);
        changed.Npcs.AddNew("ExternallyAddedNpc");
        changed.WriteToBinary(pluginPath);

        var events = await ReadEventsUntilAsync(reader, "question-open", _ => true, TimeSpan.FromSeconds(10));
        Assert.Single(events);

        // No second notification trails the first once the burst finishes settling.
        await AssertNoExternalChangeAsync(reader, TimeSpan.FromSeconds(2));
    }

    // "Stop the backend, change an asset, start and load": a fresh process boundary over the same
    // on-disk mod runs the identical classifier at reconcile time.
    [Fact]
    public async Task AnAssetChangedWhileTheBackendWasDown_IsClassifiedAtTheNextLoad()
    {
        using var fx = BuildOneModOnePlugin();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        var modFolder = Path.GetDirectoryName(fx.Plugins.First(p => p.Origin == Origin).Path)!;
        File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "original");
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Everything" }))
            .EnsureSuccessStatusCode();

        _client.Dispose();
        _app.Dispose();

        File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "changed-while-medit-was-down");

        using var app2 = new WebApplicationFactory<Program>();
        using var client2 = app2.CreateClient();
        using var reader = await OpenStreamAsync(client2);

        (await PutLoadOrder(fx, client2)).EnsureSuccessStatusCode();

        var events = await ReadEventsUntilAsync(reader, "question-open", _ => true, TimeSpan.FromSeconds(10));
        var pending = Assert.Single(events);
        Assert.Contains("texture.dds",
            pending.GetProperty("externalChangeTrackedFiles").EnumerateArray().Select(k => k.GetString()));
    }

    [Fact]
    public async Task AfterAbsorb_ARestartAndLoad_PublishesNothing()
    {
        using var fx = BuildOneModOnePlugin();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" }))
            .EnsureSuccessStatusCode();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var pluginPath = fx.Plugins.First(p => p.Origin == Origin).Path;
        var changed = new Fallout4Mod(ModKey.FromFileName(Plugin), Fallout4Release.Fallout4);
        changed.Npcs.AddNew("ExternallyAddedNpc");
        changed.WriteToBinary(pluginPath);
        using (var reader = await OpenStreamAsync())
        {
            await ReadEventsUntilAsync(reader, "question-open", _ => true, TimeSpan.FromSeconds(10));
        }

        (await _client.PostAsJsonAsync("/plugins/external-change/absorb", new { origin = Origin }))
            .EnsureSuccessStatusCode();

        _client.Dispose();
        _app.Dispose();

        using var app2 = new WebApplicationFactory<Program>();
        using var client2 = app2.CreateClient();
        using var reader2 = await OpenStreamAsync(client2);

        (await PutLoadOrder(fx, client2)).EnsureSuccessStatusCode();

        await AssertNoExternalChangeAsync(reader2, TimeSpan.FromSeconds(2));
    }

    [Fact]
    public async Task AfterKeep_ARestartAndLoad_PublishesNothing()
    {
        using var fx = BuildOneModOnePlugin();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" }))
            .EnsureSuccessStatusCode();
        (await PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var pluginPath = fx.Plugins.First(p => p.Origin == Origin).Path;
        var changed = new Fallout4Mod(ModKey.FromFileName(Plugin), Fallout4Release.Fallout4);
        changed.Npcs.AddNew("ExternallyAddedNpc");
        changed.WriteToBinary(pluginPath);
        using (var reader = await OpenStreamAsync())
        {
            await ReadEventsUntilAsync(reader, "question-open", _ => true, TimeSpan.FromSeconds(10));
        }

        (await _client.PostAsJsonAsync("/plugins/external-change/keep", new { origin = Origin }))
            .EnsureSuccessStatusCode();

        _client.Dispose();
        _app.Dispose();

        using var app2 = new WebApplicationFactory<Program>();
        using var client2 = app2.CreateClient();
        using var reader2 = await OpenStreamAsync(client2);

        (await PutLoadOrder(fx, client2)).EnsureSuccessStatusCode();

        await AssertNoExternalChangeAsync(reader2, TimeSpan.FromSeconds(2));
    }
}
