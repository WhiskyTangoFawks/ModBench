using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

/// <summary>Refresh's own first step (load-instance, refresh): the index file is dropped, and mEdit
/// reads every plugin again against the load order it holds, as a cold load does. Nothing is sent.
/// </summary>
[Collection(WebHostCollection.Name)]
public sealed class IndexRebuildApiTests : HostedTests
{
    private const string Plugin = "Rebuild.esp";
    private const string Origin = "RebuildMod";

    private static readonly TimeSpan RefillWithin = TimeSpan.FromSeconds(20);

    private static ScatteredFixtureData OneMod() =>
        new PluginFixtureBuilder("api-rebuild")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("RebuildNpc"), origin: Origin)
            .BuildScattered();

    private Task<HttpResponseMessage> Rebuild(string instanceRoot) =>
        Client.PostAsJsonAsync("/index/rebuild", new { instanceRoot, gameRelease = "Fallout4" });

    private async Task<JsonElement> Status() => await Client.GetFromJsonAsync<JsonElement>("/load-order/status");

    [Fact]
    public async Task RebuildingWithALoadOrderHeld_ReadsEveryPluginAgain_WithNoPut_WithoutRegressingTheSequence()
    {
        using var fx = OneMod();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        var formKey = await Client.FirstFormKey(Plugin);
        var before = await Client.Sequence();
        var held = (await Status()).GetProperty("version").GetInt64();
        Assert.True(before > 0, "loading must have advanced the sequence past 0");

        var rebuilt = await Rebuild(fx.InstanceRoot);

        Assert.Equal(HttpStatusCode.NoContent, rebuilt.StatusCode);
        await Client.AwaitTerminalLoadOrderStatus(held, RefillWithin);
        Assert.Equal("Ready", (await Status()).GetProperty("state").GetString());
        Assert.Equal("RebuildNpc", (await Client.Record(formKey)).GetProperty("editorId").GetString());
        Assert.True(
            await Client.Sequence() >= before,
            "the sequence regressed across a rebuild, so a reader could miss the projection that followed");
    }

    [Fact]
    public async Task RebuildingWithNoLoadOrderHeld_LeavesTheIndexEmpty_WithoutAFailure()
    {
        using var fx = OneMod();

        var rebuilt = await Rebuild(fx.InstanceRoot);

        Assert.Equal(HttpStatusCode.NoContent, rebuilt.StatusCode);
        var status = await Status();
        Assert.Equal("None", status.GetProperty("state").GetString());
        Assert.True(
            !status.TryGetProperty("message", out var message) || message.ValueKind == JsonValueKind.Null,
            $"a rebuild with no load order held reported: {message}");
    }

    [Fact]
    public async Task RebuildingAnInstanceRootThatIsNotThere_Is400()
    {
        var rebuilt = await Rebuild(Path.Combine(Path.GetTempPath(), $"no-such-instance-{Guid.NewGuid():N}"));

        Assert.Equal(HttpStatusCode.BadRequest, rebuilt.StatusCode);
    }
}
