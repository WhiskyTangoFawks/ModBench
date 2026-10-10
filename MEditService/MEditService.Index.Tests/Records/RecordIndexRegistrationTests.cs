using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Records;

public sealed class RecordIndexRegistrationTests
{
    [Fact]
    public async Task ALoadOrderSentBeforeTheFirstQuery_IsReconciledOnceTheHostHasStarted()
    {
        var holder = new LoadOrderHolder();
        using var fixture = new PluginFixtureBuilder("registration-startup")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromA"))
            .Build();
        await using var provider = Indexes.Container(holder);
        foreach (var hosted in provider.GetServices<IHostedService>()) await hosted.StartAsync(CancellationToken.None);

        var version = holder.Apply(LoadOrderArrival.Snapshot(fixture.DataFolder, null, GameRelease.Fallout4, fixture.Plugins));

        var records = provider.GetRequiredService<IQueries>();
        Waits.Reached(() => records.GetStatus().Version >= version, "the status answering the arrival");
        Assert.Equal(LoadOrderState.Ready, records.GetStatus().State);
    }
}
