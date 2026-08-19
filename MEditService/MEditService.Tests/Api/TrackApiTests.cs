using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Core.Ledger;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>
/// #414/ADR-0041: the wire contract for the Track gesture — the fourth of #414's touch points
/// (backend endpoint, the others are the frontend command chain). Real HTTP host, real session,
/// real mod folder on disk.
/// </summary>
public sealed class TrackApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private static ScatteredFixtureData BuildOneModOnePlugin() =>
        new PluginFixtureBuilder("api-track")
            .WithPlugin("Tracked.esp", mod => mod.Npcs.AddNew("SomeNpc"), origin: "TrackedMod")
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

    [Fact]
    public async Task Track_ARealLoadedMod_CreatesTheRepoInItsModFolder()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx, "TrackedMod");
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "TrackedMod").Path)!;

        var response = await _client.PostAsJsonAsync("/plugins/track", new { origin = "TrackedMod", preset = "Edits" });

        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("TrackedMod", body.GetProperty("origin").GetString());
        Assert.True(LedgerRepository.IsTracked(modFolder));
    }

    [Fact]
    public async Task Track_WithoutAnOrigin_Is400()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx, "TrackedMod");

        var response = await _client.PostAsJsonAsync("/plugins/track", new { origin = "", preset = "Edits" });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Track_AnOriginNoLoadedPluginHas_Is404()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx, "TrackedMod");

        var response = await _client.PostAsJsonAsync("/plugins/track", new { origin = "NoSuchMod", preset = "Edits" });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Track_ANeverTrackedMod_ThenTrackedAgain_Is409()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx, "TrackedMod");

        var first = await _client.PostAsJsonAsync("/plugins/track", new { origin = "TrackedMod", preset = "Edits" });
        first.EnsureSuccessStatusCode();

        var second = await _client.PostAsJsonAsync("/plugins/track", new { origin = "TrackedMod", preset = "Edits" });

        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
    }
}
