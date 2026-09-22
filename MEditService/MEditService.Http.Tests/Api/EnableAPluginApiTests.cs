using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Api;

/// <summary>enable-a-plugin: the plugins.txt splice reaches mEdit as the next snapshot, and the
/// implicit masters the splice needs are asked of mEdit with no load order held at all.</summary>
[Collection(WebHostCollection.Name)]
public sealed class EnableAPluginApiTests : HostedTests
{
    private const string First = "First.esp";
    private const string Second = "Second.esp";
    private const string FirstMod = "FirstMod";
    private const string SecondMod = "SecondMod";

    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("trace-enable-a-plugin")
        .WithPlugin(First, mod => mod.Npcs.AddNew("FirstNpc"), origin: FirstMod)
        .WithPlugin(Second, mod => mod.Npcs.AddNew("SecondNpc"), origin: SecondMod)
        .BuildScattered();

    protected override void DisposeFixtures() => _instance.Dispose();

    [Fact]
    public async Task EnablingAPlugin_FlipsItFromDormantToParticipating_WithTheFactsThatSayWhy()
    {
        var dormant = _instance.Plugins.Select(p => p.Name == Second ? p with { Enabled = false } : p);
        (await Client.PutLoadOrder(_instance, dormant)).EnsureSuccessStatusCode();
        var before = await Client.Plugin(Second);
        Assert.False(before.GetProperty("enabled").GetBoolean());
        Assert.False(before.GetProperty("participates").GetBoolean());

        (await Client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();

        var after = await Client.Plugin(Second);
        Assert.True(after.GetProperty("enabled").GetBoolean());
        Assert.True(after.GetProperty("participates").GetBoolean());
        Assert.True(after.GetProperty("inLoadOrder").GetBoolean());
    }

    [Fact]
    public async Task ReorderingThePlugins_ComesBackInTheNewOrder()
    {
        (await Client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();
        Assert.Equal(0, (await Client.Plugin(First)).GetProperty("loadOrderIndex").GetInt32());

        var swapped = _instance.Plugins.Select(p => p with { Slot = p.Name == First ? 1 : 0 });
        (await Client.PutLoadOrder(_instance, swapped)).EnsureSuccessStatusCode();

        Assert.Equal(1, (await Client.Plugin(First)).GetProperty("loadOrderIndex").GetInt32());
        Assert.Equal(0, (await Client.Plugin(Second)).GetProperty("loadOrderIndex").GetInt32());
    }

    // The splice asks this while it is still building the snapshot, so the answer comes from the
    // game directory alone — on this host nothing has ever been put.
    [Fact]
    public async Task TheImplicitMasters_AreAnsweredWithNoLoadOrderHeld()
    {
        using var install = new PluginFixtureBuilder("trace-implicit-masters")
            .WithPlugin("Fallout4.esm", listed: false)
            .WithPlugin("UserMod.esp")
            .Build();
        using var app = new MEditHost();
        using var client = app.CreateClient();

        var masters = await client.GetFromJsonAsync<JsonElement>(
            $"/implicit-masters?gameDirectory={Uri.EscapeDataString(install.DataFolder)}&gameRelease=Fallout4");

        Assert.Equal(["Fallout4.esm"], masters.EnumerateArray().Select(m => m.GetString()));
    }

    [Fact]
    public async Task TheImplicitMastersOfADirectoryThatIsNotThere_Is400()
    {
        var absent = Path.Combine(Path.GetTempPath(), $"no-such-data-{Guid.NewGuid():N}");

        var response = await Client.GetAsync(
            new Uri($"/implicit-masters?gameDirectory={Uri.EscapeDataString(absent)}&gameRelease=Fallout4", UriKind.Relative));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task TheImplicitMastersOfAReleaseTheServiceDoesNotKnow_Is400()
    {
        var response = await Client.GetAsync(new Uri(
            $"/implicit-masters?gameDirectory={Uri.EscapeDataString(_instance.GameDirectory)}&gameRelease=Morrowind",
            UriKind.Relative));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
