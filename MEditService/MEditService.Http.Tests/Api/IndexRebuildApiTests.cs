using System.Net;
using System.Net.Http.Json;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Api;

/// <summary>Refresh's own first step, which no trace draws: the index file is dropped and the
/// PUT that follows is an ordinary cold load.</summary>
[Collection(WebHostCollection.Name)]
public sealed class IndexRebuildApiTests : HostedTests
{
    private const string Plugin = "Rebuild.esp";
    private const string Origin = "RebuildMod";

    private static ScatteredFixtureData OneMod() =>
        new PluginFixtureBuilder("api-rebuild")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("RebuildNpc"), origin: Origin)
            .BuildScattered();

    private Task<HttpResponseMessage> Rebuild(string instanceRoot) =>
        Client.PostAsJsonAsync("/index/rebuild", new { instanceRoot, gameRelease = "Fallout4" });

    [Fact]
    public async Task RebuildingThenResendingTheLoadOrder_AnswersAgain_WithoutRegressingTheSequence()
    {
        using var fx = OneMod();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        var formKey = await Client.FirstFormKey(Plugin);
        var before = await Client.Sequence();
        Assert.True(before > 0, "loading must have advanced the sequence past 0");

        var rebuilt = await Rebuild(fx.InstanceRoot);

        Assert.Equal(HttpStatusCode.NoContent, rebuilt.StatusCode);
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        Assert.Equal("RebuildNpc", (await Client.Record(formKey)).GetProperty("editorId").GetString());
        Assert.True(
            await Client.Sequence() >= before,
            "the sequence regressed across a rebuild, so a reader could miss the projection that followed");
    }

    [Fact]
    public async Task RebuildingAnInstanceRootThatIsNotThere_Is400()
    {
        var rebuilt = await Rebuild(Path.Combine(Path.GetTempPath(), $"no-such-instance-{Guid.NewGuid():N}"));

        Assert.Equal(HttpStatusCode.BadRequest, rebuilt.StatusCode);
    }
}
