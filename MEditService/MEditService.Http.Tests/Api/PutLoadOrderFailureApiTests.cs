using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class PutLoadOrderFailureApiTests : HostedTests
{
    [Fact]
    public async Task PutLoadOrder_WhenApplyingTheSnapshotFails_Is500()
    {
        var fx = Owned(new PluginFixtureBuilder("api-put-load-order-failure")
            .WithPlugin("Held.esp", mod => mod.Npcs.AddNew("HeldNpc"), origin: "HeldMod")
            .BuildScattered());
        Services.GetRequiredService<LoadOrderHolder>().Arrived += (_, _) => throw new InvalidOperationException("A subscriber failed.");

        var response = await Client.PutAsJsonAsync("/load-order", SnapshotPlugins.Body(fx.GameDirectory, fx.InstanceRoot, fx.Plugins));

        await response.AssertIsProblem(HttpStatusCode.InternalServerError);
    }
}
