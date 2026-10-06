using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class PluginProblemsNotReadyApiTests : HostedTests
{
    protected override MEditHost CreateHost() => new(ReconcilingIndex.Replace);

    [Fact]
    public async Task GetProblems_WhileTheIndexIsReconciling_Is503AndSaysItIsNotFinished()
    {
        var fx = Owned(new PluginFixtureBuilder("api-plugin-problems-not-ready")
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("Base"), origin: "BaseMod")
            .BuildScattered());
        (await Client.PutAsJsonAsync("/load-order", SnapshotPlugins.Body(fx.GameDirectory, fx.InstanceRoot, fx.Plugins)))
            .EnsureSuccessStatusCode();

        var response = await Client.GetAsync(new Uri("/plugins/problems", UriKind.Relative));

        var problem = await response.AssertIsProblem(HttpStatusCode.ServiceUnavailable);
        Assert.Contains("index is not ready", problem.GetProperty("detail").GetString(), StringComparison.Ordinal);
    }
}
