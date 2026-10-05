using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class IndexFailureApiTests : HostedTests
{
    private const string Plugin = "Held.esp";
    private const string Origin = "HeldMod";
    private const string EscapedFormKey = "000800%3AHeld.esp";

    protected override MEditHost CreateHost() => new(services => UnreachableIndex.Replace(services));

    private static async Task AssertIsProblem500(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal(500, (await response.Body()).GetProperty("status").GetInt32());
    }

    private async Task LoadOrderHeld()
    {
        var fx = Owned(new PluginFixtureBuilder("api-index-failure")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("HeldNpc"), origin: Origin)
            .BuildScattered());
        var put = await Client.PutAsJsonAsync("/load-order", SnapshotPlugins.Body(fx.GameDirectory, fx.InstanceRoot, fx.Plugins));
        put.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task SetFilter_WhenTheIndexFails_Is500() =>
        await AssertIsProblem500(await Client.PostAsJsonAsync(
            "/load-order/filter", new { sql = "SELECT form_key FROM \"NPC_\"", source = "npcs.sql" }));

    [Fact]
    public async Task ClearFilter_WhenTheIndexFails_Is500() =>
        await AssertIsProblem500(await Client.DeleteAsync("/load-order/filter"));

    [Fact]
    public async Task PostRebuildIndex_WhenTheIndexFails_Is500()
    {
        using var instance = new ScratchDirectory("medit-rebuild-");

        await AssertIsProblem500(await Client.PostAsJsonAsync(
            "/index/rebuild", new { instanceRoot = instance.ToString(), gameRelease = "Fallout4" }));
    }

    [Fact]
    public async Task GetReferences_WhenTheIndexFails_Is500()
    {
        await LoadOrderHeld();

        await AssertIsProblem500(await Client.GetAsync(new Uri($"/records/{EscapedFormKey}/references", UriKind.Relative)));
    }

    [Theory]
    [InlineData($"/plugins/{Plugin}/records/{EscapedFormKey}/children")]
    [InlineData($"/plugins/{Plugin}/worldspaces")]
    [InlineData($"/plugins/{Plugin}/worldspaces/{EscapedFormKey}/blocks")]
    [InlineData($"/plugins/{Plugin}/cells/{EscapedFormKey}/children")]
    [InlineData($"/plugins/{Plugin}/interior-cells")]
    public async Task APluginRead_WhenTheIndexFails_Is500(string route)
    {
        await LoadOrderHeld();

        await AssertIsProblem500(await Client.GetAsync(new Uri($"{route}?origin={Origin}", UriKind.Relative)));
    }
}
