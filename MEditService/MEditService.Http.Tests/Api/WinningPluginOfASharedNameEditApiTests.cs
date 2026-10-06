using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class WinningPluginOfASharedNameEditApiTests : HostedTests
{
    private const string PluginName = "Shared.esp";
    private const string WinningOrigin = "WinningMod";
    private const string OverriddenOrigin = "OverriddenMod";

    private async Task<ScatteredFixtureData> Loaded()
    {
        var fx = new PluginFixtureBuilder("api-overridden-plugin")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("OverriddenNpc"), origin: OverriddenOrigin)
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("WinningNpc"), origin: WinningOrigin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track([WinningOrigin, OverriddenOrigin])).EnsureSuccessStatusCode();
        return fx;
    }

    [Fact]
    public async Task EditingTheWinningPlugin_OfTheSameName_Lands()
    {
        using var fx = await Loaded();
        var formKey = await Client.FirstFormKey(PluginName, WinningOrigin);

        var response = await Client.Edit(formKey, PluginName, WinningOrigin, "HeightMax", 0.75);

        response.EnsureSuccessStatusCode();
        Assert.NotEmpty((await response.Body()).GetProperty("documents").EnumerateArray());
    }
}
