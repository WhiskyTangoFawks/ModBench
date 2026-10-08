using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class RecordCompareNotReadyApiTests : HostedTests
{
    private readonly ParkedPluginAdapter _parked = new();

    protected override MEditHost CreateHost() => new(_parked.Replace);

    [Fact]
    public async Task GetCompare_WhileTheIndexIsReconciling_Is503AndSaysItIsNotFinished()
    {
        var fx = Owned(new PluginFixtureBuilder("api-compare-not-ready")
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("Base"), origin: "BaseMod")
            .BuildScattered());
        (await Client.PutAsJsonAsync("/load-order", SnapshotPlugins.Body(fx.GameDirectory, fx.InstanceRoot, fx.Plugins)))
            .EnsureSuccessStatusCode();

        var response = await Client.GetAsync(new Uri("/records/000800:Base.esm/compare", UriKind.Relative));
        _parked.Release();

        var problem = await response.AssertIsProblem(HttpStatusCode.ServiceUnavailable);
        Assert.Contains("index is not ready", problem.GetProperty("detail").GetString(), StringComparison.Ordinal);
    }
}
