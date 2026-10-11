using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Http.Tests.RealData;

public sealed class InstanceCatalogTests
{
    private static readonly Dictionary<string, GameRelease> ReleaseByMo2GameName = new()
    {
        ["Fallout 4"] = GameRelease.Fallout4,
        ["Skyrim Special Edition"] = GameRelease.SkyrimSE,
        ["Starfield"] = GameRelease.Starfield,
    };

    private static readonly EnumerationOptions AnyCase = new() { MatchCasing = MatchCasing.CaseInsensitive };

    [SmokeFact("catalog the plugins of the MO2 instance MEDIT_CATALOG_INSTANCE names")]
    public async Task AnInstanceProfile_CopiedToScratch_IsCataloguedByReadIngestKindBAndRoundTrip()
    {
        var instance = Required("MEDIT_CATALOG_INSTANCE");
        var profile = Path.Combine(instance, "profiles", Required("MEDIT_CATALOG_PROFILE"));
        var gameDirectory = Required("MEDIT_CATALOG_GAME_DIR");
        var catalogPath = Required("MEDIT_CATALOG_OUT");
        var release = ReleaseByMo2GameName[Mo2GameName(instance)];
        var dataDir = Path.Combine(gameDirectory, "Data");

        using var scratch = new ScratchDirectory("medit-catalog-");
        var entries = ProfileWithPluginsCopiedTo(scratch.Path, instance, profile, dataDir, release);
        await using var host = new MEditHost();
        var client = host.CreateClient();
        client.Timeout = TimeSpan.FromHours(2);

        var load = await client.PutLoadOrderAndAwaitReady(
            SnapshotPlugins.Body(gameDirectory, scratch.Path, entries, release.ToString()), TimeSpan.FromHours(2));
        Assert.True(load.IsSuccessStatusCode, await load.Content.ReadAsStringAsync());

        var lines = new List<string>();
        var status = await client.GetFromJsonAsync<JsonElement>("/load-order/status");
        foreach (var failure in status.GetProperty("failures").EnumerateArray())
            lines.Add(Line(failure.GetProperty("name"), "read", failure.GetProperty("diagnosis"), failure.GetProperty("reason")));

        foreach (var plugin in (await client.GetFromJsonAsync<JsonElement>("/plugins")).EnumerateArray()
                     .Where(p => p.GetProperty("hasParseFailure").GetBoolean()))
        {
            await foreach (var record in RecordsOf(client, Text(plugin, "name"), Text(plugin, "origin")))
            {
                if (record.GetProperty("parseDiagnosis") is { ValueKind: JsonValueKind.String } diagnosis)
                    lines.Add(Line(plugin.GetProperty("name"), "ingest", record.GetProperty("formKey"), diagnosis));
            }
        }

        foreach (var diagnosis in (await client.GetFromJsonAsync<JsonElement>("/plugins/diagnoses")).EnumerateArray())
            lines.Add(Line(diagnosis.GetProperty("plugin"), "kind-b", diagnosis.GetProperty("anchor"), diagnosis.GetProperty("message")));

        foreach (var mod in SnapshotPlugins.Active(entries).Select(p => p.Origin).Distinct()
                     .Where(origin => entries.Any(e => e.Origin == origin && e.Provider is PluginProvider.FromMod)))
        {
            var track = await client.PostAsJsonAsync("/plugins/track", new { mods = new[] { mod } });
            var answer = await track.Content.ReadFromJsonAsync<JsonElement>();
            if (!track.IsSuccessStatusCode)
            {
                lines.Add($"{mod}\tround-trip\t\tTrack answered {(int)track.StatusCode}: {answer}");
                continue;
            }
            foreach (var refusal in answer.GetProperty("refused").EnumerateArray())
            {
                foreach (var message in Text(refusal, "message").Split('\n'))
                    lines.Add($"{mod}\tround-trip\t\t{message}");
            }
        }

        await File.WriteAllLinesAsync(catalogPath, lines.Order(StringComparer.Ordinal));
    }

    private static string Required(string name) =>
        Environment.GetEnvironmentVariable(name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Set {name}.");

    private static string Text(JsonElement element, string property) => element.GetProperty(property).GetString() ?? "";

    private static string Mo2GameName(string instance) =>
        File.ReadLines(Path.Combine(instance, "ModOrganizer.ini"))
            .First(line => line.StartsWith("gameName=", StringComparison.Ordinal))["gameName=".Length..];

    private static string Line(JsonElement plugin, string stage, JsonElement record, JsonElement message) =>
        $"{plugin.GetString()}\t{stage}\t{(record.ValueKind == JsonValueKind.String ? record.GetString() : "")}\t{message.GetString()?.ReplaceLineEndings(" ")}";

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
        AddFiles(winningFileByName, PluginOrigin.Overwrite, Path.Combine(instance, "overwrite"));

        var entries = Implicits.Get(release).Listings
            .Select(master => master.FileName.String)
            .Where(name => File.Exists(Path.Combine(dataDir, name)))
            .Select(name => new LoadOrderEntry(name, Path.Combine(dataDir, name), PluginOrigin.DataDirectory, null, Enabled: true, Winning: true))
            .ToList();
        var listed = File.ReadLines(Path.Combine(profile, "plugins.txt"))
            .Where(line => line.StartsWith('*'))
            .Select(line => line[1..].Trim())
            .Where(name => !entries.Exists(implicitMaster => implicitMaster.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
            .ToList();
        foreach (var name in listed)
        {
            entries.Add(winningFileByName.TryGetValue(name, out var winner)
                ? new LoadOrderEntry(Path.GetFileName(winner.Path), CopyToScratch(winner.Path, winner.Origin, scratchRoot), winner.Origin, null, Enabled: true, Winning: true)
                : new LoadOrderEntry(name, Path.Combine(dataDir, name), PluginOrigin.DataDirectory, null, Enabled: true, Winning: true));
        }
        return [.. entries.Select((entry, line) => entry with { Line = line })];
    }

    private static void AddFiles(Dictionary<string, (string, string)> winningFileByName, string origin, string folder)
    {
        if (!Directory.Exists(folder)) return;
        foreach (var file in Directory.EnumerateFiles(folder))
            winningFileByName[Path.GetFileName(file)] = (origin, file);
    }

    private static string CopyToScratch(string pluginPath, string origin, string scratchRoot)
    {
        var plugin = Path.GetFileName(pluginPath);
        var folder = Path.GetDirectoryName(pluginPath) ?? throw new InvalidOperationException($"'{pluginPath}' has no folder.");
        var target = origin == PluginOrigin.Overwrite
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
