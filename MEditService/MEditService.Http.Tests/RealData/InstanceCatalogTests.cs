using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.RealData;

public sealed class InstanceCatalogTests
{
    private static readonly EnumerationOptions AnyCase = new() { MatchCasing = MatchCasing.CaseInsensitive };

    [SmokeFact("catalog the plugins of the MO2 instance MEDIT_CATALOG_INSTANCE names")]
    public async Task AnInstanceProfile_CopiedToScratch_IsCataloguedByReadIngestKindBAndRoundTrip()
    {
        var instance = Required("MEDIT_CATALOG_INSTANCE");
        var profile = Path.Combine(instance, "profiles", Required("MEDIT_CATALOG_PROFILE"));
        var dataFolder = Path.Combine(Required("MEDIT_CATALOG_GAME_FOLDER"), "Data");
        var catalogPath = Required("MEDIT_CATALOG_OUT");
        var release = Enum.Parse<GameRelease>(Required("MEDIT_CATALOG_RELEASE"));

        using var scratch = new ScratchDirectory("medit-catalog-");
        var entries = ProfileWithPluginsCopiedTo(scratch.Path, instance, profile, dataFolder, release);
        await using var host = new MEditHost();
        var client = host.CreateClient();
        client.Timeout = TimeSpan.FromHours(2);

        var load = await client.PutLoadOrderAndAwaitReady(
            SnapshotPlugins.Body(dataFolder, scratch.Path, entries, release.ToString()), TimeSpan.FromHours(2));
        Assert.True(load.IsSuccessStatusCode, await load.Content.ReadAsStringAsync());

        var lines = new List<string>();
        var status = await client.GetFromJsonAsync<JsonElement>("/load-order/status");
        foreach (var failure in status.GetProperty("failures").EnumerateArray())
            lines.Add(Line(Text(failure, "name"), Text(failure, "origin"), "read", Text(failure, "diagnosis"), Text(failure, "reason")));

        foreach (var plugin in (await client.GetFromJsonAsync<JsonElement>("/plugins")).EnumerateArray()
                     .Where(p => p.GetProperty("hasParseFailure").GetBoolean()))
        {
            await foreach (var record in RecordsOf(client, Text(plugin, "name"), Text(plugin, "origin")))
            {
                if (Text(record, "parseDiagnosis") is { Length: > 0 })
                    lines.Add(Line(Text(plugin, "name"), Text(plugin, "origin"), "ingest", Text(record, "formKey"), Text(record, "parseDiagnosis")));
            }
        }

        foreach (var diagnosis in (await client.GetFromJsonAsync<JsonElement>("/plugins/diagnoses")).EnumerateArray())
            lines.Add(Line(Text(diagnosis, "plugin"), Text(diagnosis, "origin"), "kind-b", Text(diagnosis, "anchor"), Text(diagnosis, "message")));

        foreach (var mod in entries.Where(e => e.Provider is PluginProvider.FromMod).GroupBy(e => e.Origin))
        {
            var init = await client.DecompileAndCommit(mod.Key);
            var answer = await init.Content.ReadFromJsonAsync<JsonElement>();
            var messages = init.IsSuccessStatusCode
                ? answer.GetProperty("refused").EnumerateArray().SelectMany(r => Text(r, "message").Split('\n'))
                : [$"Init answered {(int)init.StatusCode}: {answer}"];
            foreach (var message in messages)
            {
                var plugin = mod.FirstOrDefault(e => message.StartsWith(e.Name, StringComparison.Ordinal))?.Name ?? "";
                lines.Add(Line(plugin, mod.Key, "round-trip", "", message));
            }
        }

        await File.WriteAllLinesAsync(catalogPath, lines.Order(StringComparer.Ordinal));
    }

    private static string Required(string name) =>
        Environment.GetEnvironmentVariable(name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Set {name}.");

    private static string Text(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";

    private static string Line(string plugin, string origin, string stage, string record, string message) =>
        $"{plugin}\t{origin}\t{stage}\t{record}\t{message.ReplaceLineEndings(" ")}";

    private static async IAsyncEnumerable<JsonElement> RecordsOf(HttpClient client, string plugin, string origin)
    {
        const int page = 500;
        for (var offset = 0; ; offset += page)
        {
            var result = await client.GetFromJsonAsync<JsonElement>(
                $"/records?plugin={Uri.EscapeDataString(plugin)}&origin={Uri.EscapeDataString(origin)}&limit={page}&offset={offset}");
            var items = result.GetProperty("items");
            foreach (var item in items.EnumerateArray()) yield return item;
            if (offset + items.GetArrayLength() >= result.GetProperty("total").GetInt32()) yield break;
        }
    }

    private static List<LoadOrderEntry> ProfileWithPluginsCopiedTo(
        string scratchRoot, string instance, string profile, string dataDir, GameRelease release)
    {
        var winningFileByName = new Dictionary<string, (string Origin, string Path)>(StringComparer.OrdinalIgnoreCase);
        var modsLowestFirst = File.ReadLines(Path.Combine(profile, "modlist.txt"))
            .Where(line => line.StartsWith('+'))
            .Select(line => line[1..])
            .Reverse();
        foreach (var mod in modsLowestFirst)
            AddFiles(winningFileByName, mod, Path.Combine(instance, "mods", mod));
        AddFiles(winningFileByName, LoadOrderEntry.OverwriteOrigin, Path.Combine(instance, "overwrite"));

        var implicitMasters = RealInstallSmokeTests.MastersIn(release, dataDir);
        var listed = File.ReadLines(Path.Combine(profile, "plugins.txt"))
            .Where(line => line.StartsWith('*'))
            .Select(line => line[1..].Trim())
            .Where(name => !implicitMasters.Contains(name, StringComparer.OrdinalIgnoreCase));
        var entries = implicitMasters.Concat(listed)
            .Select(name => winningFileByName.TryGetValue(name, out var winner)
                ? new LoadOrderEntry(Path.GetFileName(winner.Path), CopyToScratch(winner.Path, winner.Origin, scratchRoot), winner.Origin, null, Enabled: true, Winning: true)
                : new LoadOrderEntry(name, Path.Combine(dataDir, name), PluginOrigin.DataDirectory, null, Enabled: true, Winning: true));
        return [.. entries.Select((entry, index) => entry with { Line = index })];
    }

    private static void AddFiles(Dictionary<string, (string Origin, string Path)> winningFileByName, string origin, string folder)
    {
        if (!Directory.Exists(folder)) return;
        foreach (var file in Directory.EnumerateFiles(folder))
            winningFileByName[Path.GetFileName(file)] = (origin, file);
    }

    private static string CopyToScratch(string pluginPath, string origin, string scratchRoot)
    {
        var plugin = Path.GetFileName(pluginPath);
        var folder = Path.GetDirectoryName(pluginPath) ?? throw new InvalidOperationException($"'{pluginPath}' has no folder.");
        var target = origin == LoadOrderEntry.OverwriteOrigin
            ? Path.Combine(scratchRoot, "overwrite")
            : Path.Combine(scratchRoot, "mods", origin);
        Directory.CreateDirectory(target);
        File.Copy(pluginPath, Path.Combine(target, plugin), overwrite: true);

        foreach (var strings in Directory.EnumerateDirectories(folder, "Strings", AnyCase))
        {
            Directory.CreateDirectory(Path.Combine(target, "Strings"));
            foreach (var file in Directory.EnumerateFiles(strings, Path.GetFileNameWithoutExtension(plugin) + "_*", AnyCase))
                File.Copy(file, Path.Combine(target, "Strings", Path.GetFileName(file)), overwrite: true);
        }
        foreach (var archive in Directory.EnumerateFiles(folder, "*.ba2", AnyCase).Concat(Directory.EnumerateFiles(folder, "*.bsa", AnyCase)))
        {
            var link = Path.Combine(target, Path.GetFileName(archive));
            if (!File.Exists(link)) File.CreateSymbolicLink(link, archive);
        }
        return Path.Combine(target, plugin);
    }
}
