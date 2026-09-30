using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

/// <summary>Track over a selection answers per plugin (ADR-0019 invariant 4): Overwrite's own
/// refusal reaches the wire as "OverwriteOrigin" in the refused array, 200 OK throughout.</summary>
[Collection(WebHostCollection.Name)]
public sealed class TrackOverwriteRefusalApiTests : HostedTests
{
    private const string Plugin = "Stray.esp";

    [Fact]
    public async Task TrackingAnOverwriteOriginPlugin_AnswersItRefused_AsOverwriteOrigin()
    {
        using var fx = new PluginFixtureBuilder("api-track-overwrite-origin")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("StrayNpc"), origin: PluginOrigin.Overwrite)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var response = await Client.Track(Plugin, PluginOrigin.Overwrite);

        response.EnsureSuccessStatusCode();
        var body = await response.Body();
        Assert.Empty(body.GetProperty("applied").EnumerateArray());
        var refused = Assert.Single(body.GetProperty("refused").EnumerateArray());
        Assert.Equal("OverwriteOrigin", refused.GetProperty("refusal").GetString());
        Assert.Contains("Overwrite", refused.GetProperty("message").GetString(), StringComparison.Ordinal);
        Assert.Empty(Directory.EnumerateDirectories(fx.InstanceRoot, ".git", SearchOption.AllDirectories));
    }
}
