using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Http.Tests.Traces;

public sealed class ModStatusTraceTests : HostedTests
{
    private const string Recorded = "Recorded";
    private const string Unrecorded = "Unrecorded";

    private readonly ScratchDirectory _instance = new("trace-mod-status-");

    protected override MEditHost CreateHost() => new(services => services.AddSingleton<TimeProvider>(new ADayAhead()));

    protected override void DisposeFixtures() => _instance.Dispose();

    private string StatCache => Path.Combine(_instance, "stat-cache");

    private string FolderOf(string mod) => Path.Combine(_instance, "mods", mod);

    private void ModWithFile(string mod, string file)
    {
        Directory.CreateDirectory(FolderOf(mod));
        File.WriteAllText(Path.Combine(FolderOf(mod), file), file);
    }

    private JsonArray Mods() =>
        [.. new[] { Recorded, Unrecorded }.Select(mod => (JsonNode)new JsonObject
        {
            ["name"] = mod, ["folder"] = FolderOf(mod), ["metadataFiles"] = new JsonArray("meta.ini"),
        })];

    private async Task UpdateManifestOfRecorded() =>
        (await Client.PostAsJsonAsync("/update-manifest", new JsonObject
        {
            ["mods"] = new JsonArray(new JsonObject
            {
                ["name"] = Recorded,
                ["folder"] = FolderOf(Recorded),
                ["metadataFiles"] = new JsonArray("meta.ini"),
            }),
            ["statCache"] = StatCache,
        })).EnsureSuccessStatusCode();

    private async Task PutLoadOrder(ScatteredFixtureData fx) =>
        (await Client.PutLoadOrderAndAwaitReady(SnapshotPlugins.Body(
            fx.DataFolder, fx.InstanceRoot, fx.Plugins, mods: Mods(), statCache: StatCache))).EnsureSuccessStatusCode();

    private async Task<Dictionary<string, JsonElement>> ModStatus()
    {
        var response = await Client.PostAsJsonAsync("/mod-status", new JsonObject { ["mods"] = Mods(), ["statCache"] = StatCache });
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray()
            .ToDictionary(mod => mod.GetProperty("mod").GetString() ?? "", StringComparer.Ordinal);
    }

    private static IEnumerable<string?> Pushed(JsonElement push) => [.. push.GetProperty("mods").EnumerateArray().Select(mod => mod.GetString())];

    [Fact]
    public async Task EachSnapshot_PushesTheModsWhoseStatusChanged_AndAQueryAnswersEachModsStatus()
    {
        var fx = Owned(new PluginFixtureBuilder("trace-mod-status").WithPlugin("A.esp", origin: "A").BuildScattered());
        ModWithFile(Recorded, "a.txt");
        ModWithFile(Unrecorded, "b.txt");
        await UpdateManifestOfRecorded();
        using var stream = await Client.NotificationStream();

        await PutLoadOrder(fx);
        var first = (await stream.EventsUntil("mod-status-changed"))[^1];
        var status = await ModStatus();
        File.WriteAllText(Path.Combine(FolderOf(Recorded), "mine.txt"), "mine");
        await PutLoadOrder(fx);
        var second = (await stream.EventsUntil("mod-status-changed"))[^1];

        Assert.Equal([Recorded, Unrecorded], Pushed(first));
        Assert.Equal([Recorded, Unrecorded], status.Keys.Order(StringComparer.Ordinal));
        Assert.Equal([Recorded], Pushed(second));
    }
}
