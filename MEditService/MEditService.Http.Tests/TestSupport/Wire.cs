using System.Net.Http.Json;
using System.Text.Json;
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
        client.PutLoadOrderAndAwaitReady(SnapshotPlugins.Body(fx.GameDirectory, fx.InstanceRoot, plugins));

    /// <summary>What Modbench sends once its watch sees a change: the snapshot again, whose arrival
    /// validates every file (ADR-0003).</summary>
    internal static async Task NextSnapshot(this HttpClient client, ScatteredFixtureData fx, params string[] origins) =>
        (await client.PutLoadOrder(fx, origins)).EnsureSuccessStatusCode();

    /// <summary>Polls until <paramref name="holds"/>: validation runs on the service's own thread, and
    /// a validation that finds nothing publishes nothing to wait on.</summary>
    internal static async Task Eventually(Func<Task<bool>> holds, string what)
    {
        var elapsed = System.Diagnostics.Stopwatch.StartNew();
        while (!await holds())
        {
            Assert.True(elapsed.Elapsed < Patience, $"never: {what}");
            await Task.Delay(50);
        }
    }

    // The plugins loaded with no line load whatever mods a snapshot names.
    private static IEnumerable<LoadOrderEntry> Listed(ScatteredFixtureData fx, string[] origins) =>
        origins.Length == 0
            ? fx.Plugins
            : fx.Plugins.Where(p => p.LoadedWithNoLine || origins.Contains(p.Origin, StringComparer.Ordinal));

    internal static Task<HttpResponseMessage> SetFilter(this HttpClient client) =>
        client.PostAsJsonAsync("/load-order/filter", new { sql = "SELECT form_key FROM \"NPC_\"", source = "npcs.sql" });

    internal static Task<HttpResponseMessage> RebuildIndex(this HttpClient client, string instanceRoot) =>
        client.PostAsJsonAsync("/index/rebuild", new { instanceRoot, gameRelease = "Fallout4" });

    internal static async Task<JsonElement> AssertIsProblem(this HttpResponseMessage response, System.Net.HttpStatusCode status)
    {
        Assert.Equal(status, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var problem = await response.Body();
        Assert.Equal((int)status, problem.GetProperty("status").GetInt32());
        return problem;
    }

    internal static Task<HttpResponseMessage> Track(this HttpClient client, string mod) =>
        client.Track([mod]);

    internal static Task<HttpResponseMessage> Track(this HttpClient client, IEnumerable<string> mods) =>
        client.PostAsJsonAsync("/plugins/track", new { mods });

    internal static Task<HttpResponseMessage> Decompile(
        this HttpClient client, IEnumerable<(string Plugin, string Origin)> plugins) =>
        client.PostAsJsonAsync("/plugins/decompile", new { plugins = plugins.Select(p => new { name = p.Plugin, origin = p.Origin }) });

    internal static Task<HttpResponseMessage> Compile(
        this HttpClient client, IEnumerable<(string Plugin, string Origin)> plugins) =>
        client.PostAsJsonAsync("/plugins/compile", new { plugins = plugins.Select(p => new { name = p.Plugin, origin = p.Origin }) });

    /// <summary>An edit as Modbench makes one: mEdit is given the text of the record's file and answers the changes
    /// the edit makes, and each move and then each document is saved. The answer is mEdit's.</summary>
    internal static async Task<HttpResponseMessage> Edit(
        this HttpClient client, string formKey, string plugin, string origin, string member, object value)
    {
        var response = await client.EditChanges(formKey, plugin, origin, member, value, await client.RecordFileText(formKey, plugin, origin));
        if (!response.IsSuccessStatusCode) return response;

        var changes = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
        static string Text(JsonElement element, string name) => element.GetProperty(name).GetString().Require();
        EditSaving.Save(
            changes.GetProperty("moves").EnumerateArray().Select(move => (Text(move, "from"), Text(move, "to"))),
            changes.GetProperty("documents").EnumerateArray().Select(document => (Text(document, "path"), Text(document, "text"))));
        return response;
    }

    /// <summary>The text of the file holding the plugin's copy of the record; empty when it has none.</summary>
    internal static async Task<string> RecordFileText(this HttpClient client, string formKey, string plugin, string origin)
    {
        var file = await client.GetAsync(
            $"/plugins/{Uri.EscapeDataString(plugin)}/records/{Uri.EscapeDataString(formKey)}/document?origin={Uri.EscapeDataString(origin)}");
        var path = file.IsSuccessStatusCode ? (await file.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("path").GetString() : null;
        return path is null ? "" : await File.ReadAllTextAsync(path);
    }

    internal static Task<HttpResponseMessage> EditChanges(
        this HttpClient client, string formKey, string plugin, string origin, string member, object value, string? text, string op = "set") =>
        client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/edit-changes",
            new { edit = new { plugin, origin, op, path = new[] { new { kind = "member", name = member } }, value }, text });

    internal static Task<HttpResponseMessage> Copy(
        this HttpClient client, IEnumerable<(string FormKey, string Plugin, string Origin)> records, string mode,
        IEnumerable<(string Plugin, string Origin)> destinations, bool replace = false) =>
        client.PostAsJsonAsync("/records/copy", new
        {
            records = records.Select(r => new { formKey = r.FormKey, plugin = r.Plugin, origin = r.Origin }),
            mode,
            destinations = destinations.Select(d => new { name = d.Plugin, origin = d.Origin }),
            replace,
        });

    internal static Task<HttpResponseMessage> Copy(
        this HttpClient client, string formKey, (string Plugin, string Origin) source, string mode,
        (string Plugin, string Origin) destination, bool replace = false) =>
        client.Copy([(formKey, source.Plugin, source.Origin)], mode, [destination], replace);

    // ADR-0012: a plugin is (origin, filename) together, so origin is required here too.
    internal static async Task<string> FirstFormKey(this HttpClient client, string plugin, string origin, string type = "npc_")
    {
        var records = await client.GetFromJsonAsync<JsonElement>($"/records?plugin={plugin}&origin={origin}&type={type}");
        return records.GetProperty("items")[0].GetProperty("formKey").GetString()
            ?? throw new InvalidOperationException($"Expected the first {type} record of {plugin} ({origin}) to carry a formKey.");
    }

    internal static async Task<string> FormKeyNamed(
        this HttpClient client, string plugin, string origin, string type, string editorId)
    {
        var records = await client.GetFromJsonAsync<JsonElement>($"/records?plugin={plugin}&origin={origin}&type={type}&search={editorId}");
        return records.GetProperty("items").EnumerateArray()
            .Single(r => r.GetProperty("editorId").GetString() == editorId)
            .GetProperty("formKey").GetString()
            ?? throw new InvalidOperationException($"Expected {plugin}'s {type} {editorId} to carry a formKey.");
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

    /// <summary>Track's write reaches the answers at the next snapshot (ADR-0015), whose reconcile
    /// reports the plugin tracked before it validates every plugin, so its end is awaited too.</summary>
    internal static async Task PluginReportsTracked(this HttpClient client, string name)
    {
        await Eventually(
            async () => (await client.Plugin(name)).GetProperty("isTracked").GetBoolean(),
            $"{name} reported tracked after Track");
        var status = await client.GetFromJsonAsync<JsonElement>("/load-order/status");
        await client.AwaitTerminalLoadOrderStatus(status.GetProperty("version").GetInt64());
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
