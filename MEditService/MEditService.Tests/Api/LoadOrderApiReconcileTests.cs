using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Api;

// ADR-0044: the three registration facts are Mod Management's to state, so they travel on
// the wire the same way Origin does, and participation comes back derived.
public sealed class LoadOrderApiReconcileTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private Task<HttpResponseMessage> Put(ScatteredFixtureData fx, object plugins) =>
        _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins,
            gameRelease = "Fallout4",
        });

    [Fact]
    public async Task PutLoadOrder_DisabledLine_ComesBackNonParticipating_WithTheFactsThatSayWhy()
    {
        using var fx = new PluginFixtureBuilder("api-reconcile-disabled")
            .WithPlugin("Participating.esp", mod => mod.Npcs.AddNew("FromParticipating"))
            .WithPlugin("Dormant.esp", mod => mod.Npcs.AddNew("FromDormant"), enabled: false)
            .BuildScattered();

        var response = await Put(fx, fx.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }));
        response.EnsureSuccessStatusCode();
        Assert.Equal("reconciled", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status").GetString());

        var plugins = await _client.GetFromJsonAsync<JsonElement>("/plugins");
        var byName = plugins.EnumerateArray().ToDictionary(p => p.GetProperty("name").GetString()!);
        Assert.True(byName["Participating.esp"].GetProperty("participates").GetBoolean());
        Assert.False(byName["Dormant.esp"].GetProperty("participates").GetBoolean());
        Assert.False(byName["Dormant.esp"].GetProperty("enabled").GetBoolean());
        Assert.True(byName["Dormant.esp"].GetProperty("winning").GetBoolean());
        Assert.True(byName["Dormant.esp"].GetProperty("inLoadOrder").GetBoolean());
    }

    // A bool that silently defaults to false would make every copy non-participating, so nothing
    // would win a FormKey and the whole conflict picture would be empty but well-formed — the
    // silent-wrong-state class ADR-0026 exists to stop, and the same reason Origin is rejected
    // rather than defaulted.
    [Theory]
    [InlineData("enabled")]
    [InlineData("winning")]
    public async Task PutLoadOrder_PluginMissingARegistrationFact_Returns400(string omitted)
    {
        using var fx = new PluginFixtureBuilder("api-reconcile-missing-" + omitted)
            .WithPlugin("A.esp")
            .BuildScattered();
        var p = fx.Plugins.Single();
        object plugins = omitted == "enabled"
            ? new[] { new { p.Name, p.Path, p.Origin, p.Slot, p.Winning } }
            : new[] { new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled } };

        var response = await Put(fx, plugins);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task PutLoadOrder_UnlistedCopy_HasNoSlot_AndIsNotInTheLoadOrder()
    {
        using var fx = new PluginFixtureBuilder("api-reconcile-unlisted")
            .WithPlugin("Listed.esp")
            .WithPlugin("Stray.esp")
            .BuildScattered();
        var plugins = fx.Plugins.Select(p => p.Name == "Stray.esp" ? p with { Slot = null } : p);

        var response = await Put(fx, plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }));
        response.EnsureSuccessStatusCode();

        var stray = (await _client.GetFromJsonAsync<JsonElement>("/plugins")).EnumerateArray()
            .Single(p => p.GetProperty("name").GetString() == "Stray.esp");
        Assert.Equal(JsonValueKind.Null, stray.GetProperty("loadOrderIndex").ValueKind);
        Assert.False(stray.GetProperty("inLoadOrder").GetBoolean());
        Assert.False(stray.GetProperty("participates").GetBoolean());
        Assert.True(stray.GetProperty("isImmutable").GetBoolean());
    }

    [Fact]
    public async Task PutLoadOrder_TwiceIdentical_StaysReadyWithConflictsComputed()
    {
        using var fx = new PluginFixtureBuilder("api-reconcile-idempotent")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .BuildScattered();
        var plugins = fx.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }).ToList();

        (await Put(fx, plugins)).EnsureSuccessStatusCode();
        (await Put(fx, plugins)).EnsureSuccessStatusCode();

        var status = await _client.GetFromJsonAsync<JsonElement>("/load-order/status");
        Assert.Equal("Ready", status.GetProperty("state").GetString());
        Assert.True(status.GetProperty("conflictsComputed").GetBoolean());
    }

    // ADR-0037: a missing master is detection and display (MasterResolution), never a
    // change to participation — a plugin enabled in plugins.txt with a missing master keeps
    // competing for winner exactly as it would without the flag.
    [Fact]
    public async Task PutLoadOrder_ParticipatingPluginWithMissingMaster_StaysParticipating()
    {
        using var fx = new PluginFixtureBuilder("api-reconcile-missing-master")
            .WithPlugin("Patch.esp", mod => mod.Npcs.AddNew("PatchedNpc").Race.SetTo(
                new FormKey(ModKey.FromFileName("Ghost.esm"), 0x800)))
            .BuildScattered();

        var response = await Put(fx, fx.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }));
        response.EnsureSuccessStatusCode();

        var patch = (await _client.GetFromJsonAsync<JsonElement>("/plugins")).EnumerateArray()
            .Single(p => p.GetProperty("name").GetString() == "Patch.esp");
        Assert.True(patch.GetProperty("participates").GetBoolean());
        Assert.NotEmpty(patch.GetProperty("masterIssues").EnumerateArray());
    }
}
