using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

// #279 / ADR-0035 § Live mutation: the wire contract for the per-plugin re-read a drifted row
// offers. Mod Management owns "which file does this name resolve to" and states the answer here —
// the same division of labour /plugins/load already uses, and the reason this takes a path and an
// origin rather than re-resolving anything itself.
public sealed class RereadPluginApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    /// <summary>Two physical copies of one filename in two mod folders, distinguishable only by
    /// content: each carries a single NPC whose EditorID names the mod it came from, and both land
    /// on the same FormKey (each copy runs its own NextFormID sequence from the same ModKey). Only
    /// the ModA copy is in the load order — MO2's file-conflict merge picks one winner, so
    /// plugins.txt can never name both.</summary>
    private static ScatteredFixtureData BuildTwoCopies() =>
        new PluginFixtureBuilder("api-reread")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModB"), origin: "ModB")
            .BuildScattered();

    private async Task LoadOnly(ScatteredFixtureData fx, string origin)
    {
        var load = await _client.PostAsJsonAsync("/session/load-explicit", new
        {
            gameDirectory = fx.GameDirectory,
            plugins = fx.Plugins.Where(p => p.Origin == origin)
                .Select(p => new { name = p.Name, path = p.Path, origin = p.Origin, participates = true }),
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();
    }

    private async Task<string?> OriginOfLoadedShared() =>
        (await _client.GetFromJsonAsync<JsonElement>("/plugins"))
            .EnumerateArray()
            .Single(p => p.GetProperty("name").GetString() == "Shared.esp")
            .GetProperty("origin").GetString();

    [Fact]
    public async Task Reread_FromTheCopyTheNameNowResolvesTo_AnswersWithTheReboundPlugin()
    {
        using var fx = BuildTwoCopies();
        await LoadOnly(fx, "ModA");
        var replacement = fx.Plugins.Single(p => p.Origin == "ModB");

        var response = await _client.PostAsJsonAsync("/plugins/reread", new
        {
            plugin = "Shared.esp",
            path = replacement.Path,
            origin = "ModB",
        });

        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Shared.esp", body.GetProperty("name").GetString());
        Assert.Equal("ModB", body.GetProperty("origin").GetString());
        Assert.Equal(replacement.Path, body.GetProperty("path").GetString());
        Assert.Equal("ModB", await OriginOfLoadedShared());
    }

    [Fact]
    public async Task Reread_WithoutAPath_Is400()
    {
        using var fx = BuildTwoCopies();
        await LoadOnly(fx, "ModA");

        var response = await _client.PostAsJsonAsync("/plugins/reread", new { plugin = "Shared.esp", path = "", origin = "ModB" });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Reread_WithoutAnOrigin_Is400()
    {
        using var fx = BuildTwoCopies();
        await LoadOnly(fx, "ModA");
        var replacement = fx.Plugins.Single(p => p.Origin == "ModB");

        var response = await _client.PostAsJsonAsync("/plugins/reread", new { plugin = "Shared.esp", path = replacement.Path, origin = "" });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // 404, not 409: unlike /plugins/unload — whose common refusal is naming a plugin that *is*
    // loaded but is a load-order member — the only way to reach this is naming a plugin the load
    // order does not have, which is a genuinely missing resource.
    [Fact]
    public async Task Reread_APluginTheLoadOrderDoesNotName_Is404()
    {
        using var fx = BuildTwoCopies();
        await LoadOnly(fx, "ModA");
        var replacement = fx.Plugins.Single(p => p.Origin == "ModB");

        var response = await _client.PostAsJsonAsync("/plugins/reread", new
        {
            plugin = "NotInTheLoadOrder.esp",
            path = replacement.Path,
            origin = "ModB",
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Reread_AFileThatIsNotThere_Is404()
    {
        using var fx = BuildTwoCopies();
        await LoadOnly(fx, "ModA");

        var response = await _client.PostAsJsonAsync("/plugins/reread", new
        {
            plugin = "Shared.esp",
            path = Path.Combine(fx.Root, "gone", "Shared.esp"),
            origin = "ModB",
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        // Refused before anything was touched: the session still serves the copy it loaded.
        Assert.Equal("ModA", await OriginOfLoadedShared());
    }
}
