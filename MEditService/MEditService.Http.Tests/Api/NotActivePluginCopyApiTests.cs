using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class NotActivePluginCopyApiTests : HostedTests
{
    private const string DisabledPlugin = "Disabled.esp";
    private const string DisabledOrigin = "DisabledMod";
    private const string OriginPlugin = "Origin.esp";
    private const string OriginOrigin = "OriginMod";

    [Fact]
    public async Task CopyingAsOverride_IntoADisabledPluginWhoseLineIsBeforeTheOrigin_IsRefusedAsAnUnderride()
    {
        using var fx = new PluginFixtureBuilder("api-not-active-copy")
            .WithPlugin(DisabledPlugin, origin: DisabledOrigin, enabled: false)
            .WithPlugin(OriginPlugin, mod => mod.Npcs.AddNew("OriginNpc"), origin: OriginOrigin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(DisabledOrigin)).EnsureSuccessStatusCode();
        var formKey = await Client.FirstFormKey(OriginPlugin, OriginOrigin);

        var response = await Client.Copy(formKey, (OriginPlugin, OriginOrigin), "Override", (DisabledPlugin, DisabledOrigin));

        response.EnsureSuccessStatusCode();
        var refused = Assert.Single((await response.Body()).GetProperty("refused").EnumerateArray());
        Assert.Equal("UnderrideDestination", refused.GetProperty("refusal").GetString());
    }
}
