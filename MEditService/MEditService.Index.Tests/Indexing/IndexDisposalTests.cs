using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Indexing;

public class IndexDisposalTests
{
    [Fact]
    public async Task DisposingTheIndexWhileItReadsAPlugin_StopsTheReadPartway()
    {
        using var fixture = new PluginFixtureBuilder("index-disposal")
            .WithPlugin("Long.esp", mod =>
            {
                for (var i = 0; i < 200; i++) mod.Npcs.AddNew($"LongNPC{i}");
            })
            .Build();
        var holder = new LoadOrderHolder();
        var reading = new TaskCompletionSource();
        using var index = Indexes.Open(holder, new PartwayAdapter(
            afterRecords: 2, () => reading.TrySetResult(), thenEachRecordTakes: TimeSpan.FromMilliseconds(50)));
        holder.Apply(LoadOrderArrival.Snapshot(fixture.DataFolder, instanceRoot: null, GameRelease.Fallout4, fixture.Plugins));
        await reading.Task.WaitAsync(TimeSpan.FromSeconds(30));

        var disposing = Task.Run(index.Dispose);

        Assert.Same(disposing, await Task.WhenAny(disposing, Task.Delay(TimeSpan.FromSeconds(5))));
    }
}
