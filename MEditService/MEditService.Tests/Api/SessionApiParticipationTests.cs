using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Api;

// #270 / ADR-0035: participation — the plugins.txt `*` prefix — is Mod Management's to state, so it
// travels on the wire the same way Origin does (#269). The explicit load path is the only one the
// extension uses, and it previously hardcoded every plugin as participating.
public sealed class SessionApiParticipationTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    [Fact]
    public async Task PostSessionLoadExplicit_NonParticipatingPlugin_ParticipationRoundTripsToGetPlugins()
    {
        using var fx = new PluginFixtureBuilder("api-explicit-participation")
            .WithPlugin("Participating.esp", mod => mod.Npcs.AddNew("FromParticipating"))
            .WithPlugin("Dormant.esp", mod => mod.Npcs.AddNew("FromDormant"), enabled: false)
            .BuildScattered();

        var response = await _client.PostAsJsonAsync("/session/load-explicit", new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Select(p => new { name = p.Name, path = p.Path, origin = p.Origin, participates = p.Participates }),
            gameRelease = "Fallout4",
        });
        response.EnsureSuccessStatusCode();

        var plugins = await _client.GetFromJsonAsync<JsonElement>("/plugins");
        var byName = plugins.EnumerateArray().ToDictionary(p => p.GetProperty("name").GetString()!);
        Assert.True(byName["Participating.esp"].GetProperty("participates").GetBoolean());
        Assert.False(byName["Dormant.esp"].GetProperty("participates").GetBoolean());
    }

    // A bool that silently defaults to false would make every plugin non-participating, so nothing
    // would win a FormKey and the whole conflict picture would be empty but well-formed — the
    // silent-wrong-state class ADR-0026 exists to stop, and the same reason Origin is rejected
    // rather than defaulted (#275).
    [Fact]
    public async Task PostSessionLoadExplicit_PluginMissingParticipates_Returns400()
    {
        using var fx = new PluginFixtureBuilder("api-explicit-participation-missing")
            .WithPlugin("A.esp")
            .BuildScattered();

        var response = await _client.PostAsJsonAsync("/session/load-explicit", new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            // Deliberately no `participates` — this is the omission the guard exists to catch.
            plugins = fx.Plugins.Select(p => new { name = p.Name, path = p.Path, origin = p.Origin }),
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // #277 / ADR-0037 AC3: a missing master is detection and display (MasterResolution), never a
    // change to loading — nothing computes or consumes it on the participation path, so a plugin
    // enabled in plugins.txt with a missing master keeps competing for winner exactly as it would
    // without the flag. Pinning, not new behavior: today nothing couples the two at all.
    [Fact]
    public async Task PostSessionLoadExplicit_ParticipatingPluginWithMissingMaster_StaysParticipating()
    {
        using var fx = new PluginFixtureBuilder("api-explicit-participation-missing-master")
            .WithPlugin("Patch.esp", mod => mod.Npcs.AddNew("PatchedNpc").Race.SetTo(
                new FormKey(ModKey.FromFileName("Ghost.esm"), 0x800)))
            .BuildScattered();

        var response = await _client.PostAsJsonAsync("/session/load-explicit", new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Select(p => new { name = p.Name, path = p.Path, origin = p.Origin, participates = p.Participates }),
            gameRelease = "Fallout4",
        });
        response.EnsureSuccessStatusCode();

        var plugins = await _client.GetFromJsonAsync<JsonElement>("/plugins");
        var patch = plugins.EnumerateArray().Single(p => p.GetProperty("name").GetString() == "Patch.esp");
        Assert.True(patch.GetProperty("participates").GetBoolean());
        Assert.Single(patch.GetProperty("masterIssues").EnumerateArray());
    }
}
