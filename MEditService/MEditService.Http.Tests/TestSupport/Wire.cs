using System.Net.Http.Json;
using System.Text.Json;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>What a client says and hears over the wire, spelled once: the gestures a trace starts
/// from, the notification stream it listens on, and the answers it reads back.</summary>
internal static class Wire
{
    // How long a client waits for anything the service does on a thread of its own.
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(20);

    internal static Task<HttpResponseMessage> PutLoadOrder(
        this HttpClient client, ScatteredFixtureData fx, params string[] origins) =>
        client.PutLoadOrder(fx, Listed(fx, origins));

    internal static Task<HttpResponseMessage> PutLoadOrder(
        this HttpClient client, ScatteredFixtureData fx, IEnumerable<LoadOrderEntry> plugins) =>
        client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        });

    private static IEnumerable<LoadOrderEntry> Listed(ScatteredFixtureData fx, string[] origins) =>
        origins.Length == 0
            ? fx.Plugins
            : fx.Plugins.Where(p => origins.Contains(p.Origin, StringComparer.Ordinal));

    internal static Task<HttpResponseMessage> Track(this HttpClient client, string plugin, string origin, string preset = "Edits") =>
        client.Track([(plugin, origin)], preset);

    internal static Task<HttpResponseMessage> Track(
        this HttpClient client, IEnumerable<(string Plugin, string Origin)> plugins, string preset = "Edits") =>
        client.PostAsJsonAsync("/plugins/track", new { plugins = plugins.Select(p => new { name = p.Plugin, origin = p.Origin }), preset });

    internal static Task<HttpResponseMessage> Edit(
        this HttpClient client, string formKey, string plugin, string origin, string member, object value) =>
        client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/edit",
            new { plugin, origin, op = "set", path = new[] { new { kind = "member", name = member } }, value });

    internal static async Task<string> FirstFormKey(this HttpClient client, string plugin, string type = "npc_")
    {
        var records = await client.GetFromJsonAsync<JsonElement>($"/records?plugin={plugin}&type={type}");
        return records.GetProperty("items")[0].GetProperty("formKey").GetString()
            ?? throw new InvalidOperationException($"Expected the first {type} record of {plugin} to carry a formKey.");
    }

    internal static async Task<string> FirstFormKeyIn(
        this HttpClient client, string plugin, string origin, string type = "npc_")
    {
        var records = await client.GetFromJsonAsync<JsonElement>($"/records?plugin={plugin}&origin={origin}&type={type}");
        return records.GetProperty("items")[0].GetProperty("formKey").GetString()
            ?? throw new InvalidOperationException($"Expected the first {type} record of {plugin} ({origin}) to carry a formKey.");
    }

    internal static async Task<JsonElement> Body(this HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    internal static async Task<JsonElement> Record(this HttpClient client, string formKey, string? query = null) =>
        await client.GetFromJsonAsync<JsonElement>(
            $"/records/{Uri.EscapeDataString(formKey)}{(query is null ? string.Empty : "?" + query)}");

    internal static async Task<JsonElement> Compare(this HttpClient client, string formKey) =>
        await client.GetFromJsonAsync<JsonElement>($"/records/{Uri.EscapeDataString(formKey)}/compare");

    internal static async Task<IReadOnlyList<JsonElement>> Plugins(this HttpClient client) =>
        [.. (await client.GetFromJsonAsync<JsonElement>("/plugins")).EnumerateArray()];

    internal static async Task<JsonElement> Plugin(this HttpClient client, string name) =>
        (await client.Plugins()).Single(p => p.GetProperty("name").GetString() == name);

    /// <summary>Track's write reaches the answers through the watch it armed (ADR-0015 invariant 2),
    /// on the watcher's own thread, so the answer is polled until it reports the plugin tracked.
    /// </summary>
    internal static async Task PluginReportsTracked(this HttpClient client, string name)
    {
        var elapsed = System.Diagnostics.Stopwatch.StartNew();
        while (!(await client.Plugin(name)).GetProperty("isTracked").GetBoolean())
        {
            Assert.True(elapsed.Elapsed < Patience, $"{name} was never reported tracked after Track");
            await Task.Delay(50);
        }
    }

    internal static Task<long> Sequence(this HttpClient client) =>
        client.GetFromJsonAsync<long>("/load-order/sequence");

    /// <summary>The bounded await the extension itself polls, so a read that follows a write is
    /// taken after the projection landed rather than after a delay.</summary>
    internal static async Task SequenceReaches(this HttpClient client, long atLeast)
    {
        var response = await client.GetAsync(
            new Uri($"/load-order/sequence/await?atLeast={atLeast}&timeoutMs={(int)Patience.TotalMilliseconds}", UriKind.Relative));
        response.EnsureSuccessStatusCode();
        var answer = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(
            answer.GetProperty("reached").GetBoolean(),
            $"no projection reached sequence {atLeast}; the service stopped at {answer.GetProperty("sequence").GetInt64()}");
    }

    internal static async Task<StreamReader> NotificationStream(this HttpClient client)
    {
        var response = await client.GetAsync(
            new Uri("/notifications/stream", UriKind.Relative), HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();
        return new StreamReader(await response.Content.ReadAsStreamAsync());
    }

    /// <summary>Frames of one kind until one satisfies <paramref name="isTerminal"/>, bounded so a
    /// notification that never arrives fails loudly rather than hanging the run.</summary>
    internal static async Task<IReadOnlyList<JsonElement>> EventsUntil(
        this StreamReader reader, string kind, Func<JsonElement, bool> isTerminal, TimeSpan? within = null)
    {
        using var cts = new CancellationTokenSource(within ?? Patience);
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
            if (!line.StartsWith("data: ", StringComparison.Ordinal) || currentKind != kind) continue;

            var data = JsonDocument.Parse(line["data: ".Length..]).RootElement;
            collected.Add(data);
            if (isTerminal(data)) return collected;
        }
    }

    internal static Task<IReadOnlyList<JsonElement>> EventsUntil(this StreamReader reader, string kind) =>
        reader.EventsUntil(kind, _ => true);

    /// <summary>Every frame, of any kind, up to and including the next <paramref name="anchorKind"/>
    /// that satisfies <paramref name="isTerminal"/>: an absence claim reads off this list, never off
    /// a window where nothing arrived.</summary>
    internal static async Task<IReadOnlyList<(string Kind, JsonElement Data)>> FramesThrough(
        this StreamReader reader, string anchorKind, Func<JsonElement, bool> isTerminal, TimeSpan? within = null)
    {
        using var cts = new CancellationTokenSource(within ?? Patience);
        var collected = new List<(string Kind, JsonElement Data)>();
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
            if (!line.StartsWith("data: ", StringComparison.Ordinal) || currentKind is null) continue;

            var data = JsonDocument.Parse(line["data: ".Length..]).RootElement;
            collected.Add((currentKind, data));
            if (currentKind == anchorKind && isTerminal(data)) return collected;
        }
    }
}
