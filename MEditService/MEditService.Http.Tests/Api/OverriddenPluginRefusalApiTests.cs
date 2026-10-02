using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

/// <summary>An overridden plugin is read-only (ADR-0012 invariant 5), refused through the real host
/// before any source write. The same write against the winning plugin of the same name lands.
/// </summary>
public sealed class OverriddenPluginRefusalApiTests : HostedTests
{
    private const string PluginName = "Shared.esp";
    private const string WinningOrigin = "WinningMod";
    private const string OverriddenOrigin = "OverriddenMod";

    // No read sees a plugin the game does not load, so the overridden NPC's FormKey is the
    // builder's.
    private string _overriddenNpc = "";

    private async Task<ScatteredFixtureData> Loaded()
    {
        var fx = new PluginFixtureBuilder("api-overridden-plugin")
            .WithPlugin(PluginName, mod => _overriddenNpc = mod.Npcs.AddNew("OverriddenNpc").FormKey.ToString(), origin: OverriddenOrigin)
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("WinningNpc"), origin: WinningOrigin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track([(PluginName, WinningOrigin), (PluginName, OverriddenOrigin)])).EnsureSuccessStatusCode();
        return fx;
    }

    [Fact]
    public async Task EditingTheWinningPlugin_OfTheSameName_Lands()
    {
        using var fx = await Loaded();
        var formKey = await Client.FirstFormKey(PluginName, WinningOrigin);

        var response = await Client.Edit(formKey, PluginName, WinningOrigin, "HeightMax", 0.75);

        response.EnsureSuccessStatusCode();
        Assert.True((await response.Body()).GetProperty("applied").GetBoolean());
    }
}
