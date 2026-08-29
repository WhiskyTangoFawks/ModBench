using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

// #544: the full HTTP round trip for GET /plugins/{plugin}/delta, mirroring
// DuplicateFilenameSessionApiTests' own two-copies-of-one-filename rig (#34/ADR-0036) — this is the
// wire-shape counterpart to Query/PluginDeltaTests.cs' in-process RecordQueryService.GetPluginDelta
// coverage, proving the JSON translation (enum-as-string presence values) round-trips too.
public sealed class PluginDeltaApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;
    private static readonly ModKey SharedKey = ModKey.FromFileName("Shared.esp");

    private static ScatteredFixtureData BuildTwoCopies() =>
        new PluginFixtureBuilder("api-plugin-delta")
            .WithPlugin("Shared.esp", mod =>
            {
                mod.Npcs.Add(new Npc(new FormKey(SharedKey, 0x800), Fallout4Release.Fallout4) { EditorID = "Identical", Name = "SameName" });
                mod.Npcs.Add(new Npc(new FormKey(SharedKey, 0x802), Fallout4Release.Fallout4) { EditorID = "WinnerOnly", Name = "OnlyInWinner" });
            }, origin: "ModA")
            .WithPlugin("Shared.esp", mod =>
            {
                mod.Npcs.Add(new Npc(new FormKey(SharedKey, 0x800), Fallout4Release.Fallout4) { EditorID = "Identical", Name = "SameName" });
                mod.Npcs.Add(new Npc(new FormKey(SharedKey, 0x803), Fallout4Release.Fallout4) { EditorID = "PeerOnly", Name = "OnlyInPeer" });
            }, origin: "ModB")
            .BuildScattered();

    private async Task LoadWinningCopyThenShadowedCopy(ScatteredFixtureData fx)
    {
        var shadowed = fx.Plugins.Single(p => p.Origin == "ModB");
        var loadOrder = fx.Plugins.Where(p => p.Origin != "ModB");

        var load = await _client.PostAsJsonAsync("/session/load-explicit", new
        {
            gameDirectory = fx.GameDirectory,
            plugins = loadOrder.Select(p => new { name = p.Name, path = p.Path, origin = p.Origin, participates = true }),
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();

        var onDemand = await _client.PostAsJsonAsync("/plugins/load", new { path = shadowed.Path, origin = shadowed.Origin });
        onDemand.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task Delta_TwoCopiesOfSameFilename_ReportsOnlyPresenceDifferences()
    {
        using var fx = BuildTwoCopies();
        await LoadWinningCopyThenShadowedCopy(fx);

        var delta = await _client.GetFromJsonAsync<JsonElement>(
            "/plugins/Shared.esp/delta?winnerOrigin=ModA&peerOrigin=ModB");
        var byEditorId = delta.EnumerateArray()
            .ToDictionary(e => e.GetProperty("editorId").GetString()!, e => e.GetProperty("presence").GetString());

        // The identical NPC is absent from the wire response entirely — not present with some
        // "no diff" presence value — the same rival-killing shape the in-process test pins.
        Assert.DoesNotContain("Identical", byEditorId.Keys);
        Assert.Equal(2, delta.GetArrayLength());
        Assert.Equal("WinnerOnly", byEditorId["WinnerOnly"]);
        Assert.Equal("PeerOnly", byEditorId["PeerOnly"]);
    }

    [Fact]
    public async Task Delta_MissingOrigin_Returns400()
    {
        using var fx = BuildTwoCopies();
        await LoadWinningCopyThenShadowedCopy(fx);

        var response = await _client.GetAsync("/plugins/Shared.esp/delta?winnerOrigin=ModA");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Delta_PeerOriginNotLoaded_Returns404()
    {
        using var fx = BuildTwoCopies();
        await LoadWinningCopyThenShadowedCopy(fx);

        var response = await _client.GetAsync("/plugins/Shared.esp/delta?winnerOrigin=ModA&peerOrigin=NoSuchMod");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
