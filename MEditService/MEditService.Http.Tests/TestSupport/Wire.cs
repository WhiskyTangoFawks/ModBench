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
        client.PutLoadOrderAndAwaitReady(SnapshotPlugins.Body(fx.DataFolder, fx.InstanceRoot, plugins));

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

    internal static Task<HttpResponseMessage> PutLoadOrderIn(this HttpClient client, ScatteredFixtureData fx, string stringsLanguage) =>
        client.PutLoadOrderAndAwaitReady(SnapshotPlugins.Body(fx.DataFolder, fx.InstanceRoot, fx.Plugins, stringsLanguage: stringsLanguage));

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

    internal static Task<HttpResponseMessage> DecompileAndCommit(this HttpClient client, string mod) =>
        client.DecompileAndCommit([mod]);

    /// <summary>Each mod as one with no file of the mod manager's.</summary>
    internal static Task<HttpResponseMessage> DecompileAndCommit(this HttpClient client, IEnumerable<string> mods) =>
        client.PostAsJsonAsync("/decompile-and-commit", new
        {
            mods = mods.Select(name => new
            {
                name,
                sourceFolder = client.SourceFolderSentFor(name),
                metadataFiles = Array.Empty<string>(),
            }),
        });

    internal static Task<HttpResponseMessage> Decompile(
        this HttpClient client, IEnumerable<(string Plugin, string Origin)> plugins, bool force = false) =>
        client.PostAsJsonAsync("/plugins/decompile", new { plugins = plugins.Select(p => new { name = p.Plugin, origin = p.Origin }), force });

    internal static Task<HttpResponseMessage> Compile(
        this HttpClient client, IEnumerable<(string Plugin, string Origin)> plugins) =>
        client.PostAsJsonAsync("/plugins/compile", new { plugins = plugins.Select(p => new { name = p.Plugin, origin = p.Origin }) });

    internal static Task<HttpResponseMessage> Build(
        this HttpClient client, IEnumerable<(string Name, string Folder)> mods, string statCache, object? archives = null, string? version = null,
        string[]? tasks = null, IEnumerable<string>? made = null) =>
        client.PostAsJsonAsync("/build", new
        {
            mods = mods.Select(mod => new
            {
                name = mod.Name,
                sourceFolder = client.SourceFolderSentFor(mod.Name),
                folder = mod.Folder,
                metadataFiles = new[] { "meta.ini" },
                version,
                made,
            }),
            exclusionMark = ".mohidden",
            archives,
            statCache,
            tasks,
        });

    /// <summary>An edit as Modbench makes one: mEdit answers the changes the edit makes, and each move and then each
    /// document is saved. The answer is mEdit's.</summary>
    internal static async Task<HttpResponseMessage> Edit(
        this HttpClient client, string formKey, string plugin, string origin, string member, object value)
    {
        var response = await client.EditChanges(formKey, plugin, origin, member, value);
        if (!response.IsSuccessStatusCode) return response;

        Save(await Changes(response));
        return response;
    }

    /// <summary>A delete as Modbench makes one: mEdit answers the changes each record's deletion makes, and each
    /// landed item's are saved in the order answered. The answer is mEdit's.</summary>
    internal static async Task<HttpResponseMessage> DeleteRecords(
        this HttpClient client, IEnumerable<(string FormKey, string Plugin, string Origin)> records)
    {
        var response = await client.PostAsJsonAsync("/records/delete-changes", new
        {
            records = records.Select(r => new { formKey = r.FormKey, plugin = new { name = r.Plugin, origin = r.Origin } }),
        });
        if (!response.IsSuccessStatusCode) return response;

        foreach (var changes in (await Changes(response)).GetProperty("applied").EnumerateArray()) Save(changes);
        return response;
    }

    /// <summary>A create as Modbench makes one: mEdit answers the changes creating the record makes, and each move,
    /// deletion and document is saved. The answer is mEdit's.</summary>
    internal static async Task<HttpResponseMessage> CreateRecord(
        this HttpClient client, string plugin, string origin, string recordType, string? container = null, object? position = null)
    {
        var response = await client.PostAsJsonAsync(
            $"/plugins/{Uri.EscapeDataString(plugin)}/create-record-changes",
            new { origin, recordType, container, position });
        if (!response.IsSuccessStatusCode) return response;

        Save(await Changes(response));
        return response;
    }

    // Read as text, which the content keeps, so the caller can still read the answer.
    private static async Task<JsonElement> Changes(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

    private static void Save(JsonElement changes)
    {
        static string Text(JsonElement element, string name) => element.GetProperty(name).GetString().Require();
        EditSaving.Save(
            changes.GetProperty("moves").EnumerateArray().Select(move => (Text(move, "from"), Text(move, "to"))),
            changes.GetProperty("deletions").EnumerateArray().Select(deletion => deletion.GetString().Require()),
            changes.GetProperty("documents").EnumerateArray().Select(document => (Text(document, "path"), Text(document, "text"))));
    }

    internal static Task<HttpResponseMessage> EditChanges(
        this HttpClient client, string formKey, string plugin, string origin, string member, object value, string op = "set") =>
        client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/edit-changes",
            new { edit = new { plugin, origin, op, path = new[] { new { kind = "member", name = member } }, value } });

    /// <summary>An edit as a script makes one: mEdit writes it.</summary>
    internal static Task<HttpResponseMessage> ScriptEdit(
        this HttpClient client, string formKey, string plugin, string origin, string member, object value) =>
        client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/edit",
            new { plugin, origin, op = "set", path = new[] { new { kind = "member", name = member } }, value });

    /// <summary>The unsaved documents Modbench hands mEdit, which every changes request after it reads.</summary>
    internal static async Task HandUnsaved(this HttpClient client, params (string Path, string Text)[] unsaved) =>
        (await client.PutAsJsonAsync("/unsaved-documents", new { documents = unsaved.Select(d => new { path = d.Path, text = d.Text }) }))
        .EnsureSuccessStatusCode();

    /// <summary>A copy as Modbench makes one: mEdit answers the changes each copy makes, and each landed item's are
    /// saved in the order answered. The answer is mEdit's.</summary>
    internal static async Task<HttpResponseMessage> Copy(
        this HttpClient client, IEnumerable<(string FormKey, string Plugin, string Origin)> records, string mode,
        IEnumerable<(string Plugin, string Origin)> destinations, bool replace = false)
    {
        var response = await client.PostAsJsonAsync("/records/copy-changes", new
        {
            records = records.Select(r => new { formKey = r.FormKey, plugin = new { name = r.Plugin, origin = r.Origin } }),
            mode,
            destinations = destinations.Select(d => new { name = d.Plugin, origin = d.Origin }),
            replace,
        });
        if (!response.IsSuccessStatusCode) return response;

        foreach (var changes in (await Changes(response)).GetProperty("applied").EnumerateArray()) Save(changes);
        return response;
    }

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

    internal static async Task<HttpResponseMessage> PostJson(this HttpClient client, string route, string json)
    {
        using var content = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
        return await client.PostAsync(new Uri(route, UriKind.Relative), content);
    }

    internal static async Task<HttpResponseMessage> PutJson(this HttpClient client, string route, string json)
    {
        using var content = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
        return await client.PutAsync(new Uri(route, UriKind.Relative), content);
    }

    internal static async Task<JsonElement> Answer(HttpResponseMessage response)
    {
        response.EnsureSuccessStatusCode();
        return await response.Body();
    }

    /// <summary>The HeightMax of <paramref name="formKey"/> as a second service reads it from the plugin at
    /// <paramref name="written"/>: what was written, not what the first service holds.</summary>
    internal static async Task<double> HeightMaxInTheBytesAt(string written, string formKey)
    {
        using var elsewhere = new PluginFixtureBuilder("trace-written-reader").BuildScattered();
        using var reader = new MEditHost();
        using var client = reader.CreateClient();
        var plugin = Path.GetFileName(written);
        var copied = Path.Combine(Directory.CreateDirectory(Path.Combine(elsewhere.Root, "ReadingMod")).FullName, plugin);
        File.Copy(written, copied);

        (await client.PutLoadOrder(
            elsewhere,
            [new LoadOrderEntry(plugin, copied, "ReadingMod", Line: 0, Enabled: true, Winning: true)]))
            .EnsureSuccessStatusCode();

        return (await client.Record(formKey)).GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == "HeightMax")
            .GetProperty("value").GetDouble();
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

    /// <summary>Decompile and commit's write reaches the answers at the next snapshot (ADR-0015), whose reconcile
    /// reports the plugin compiled before it validates every plugin, so its end is awaited too.</summary>
    internal static async Task PluginReportsCompiledPlugin(this HttpClient client, string name)
    {
        await Eventually(
            async () => (await client.Plugin(name)).GetProperty("isCompiledPlugin").GetBoolean(),
            $"{name} reported a compiled plugin after init");
        var status = await client.GetFromJsonAsync<JsonElement>("/load-order/status");
        await client.AwaitTerminalLoadOrderStatus(status.GetProperty("version").GetInt64());
    }

    internal static Task<long> Sequence(this HttpClient client) =>
        client.GetFromJsonAsync<long>("/load-order/sequence");

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
        this StreamReader reader, string kind, Func<JsonElement, bool> isTerminal) =>
        [.. (await reader.FramesThrough(kind, isTerminal)).Where(frame => frame.Kind == kind).Select(frame => frame.Data)];

    internal static Task<IReadOnlyList<JsonElement>> EventsUntil(this StreamReader reader, string kind) =>
        reader.EventsUntil(kind, _ => true);

    /// <summary>Every frame, of any kind, up to and including the next <paramref name="anchorKind"/>
    /// that satisfies <paramref name="isTerminal"/>: an absence claim reads off this list, never off
    /// a window where nothing arrived.</summary>
    internal static async Task<IReadOnlyList<(string Kind, JsonElement Data)>> FramesThrough(
        this StreamReader reader, string anchorKind, Func<JsonElement, bool> isTerminal)
    {
        using var cts = new CancellationTokenSource(Patience);
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
