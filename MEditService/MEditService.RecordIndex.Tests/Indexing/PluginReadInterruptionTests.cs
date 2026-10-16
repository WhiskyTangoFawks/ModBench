using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Indexing;

public class PluginReadInterruptionTests
{
    private static PluginFixtureData LongPlugin(string name) =>
        new PluginFixtureBuilder(name)
            .WithPlugin("Long.esp", mod =>
            {
                for (var i = 0; i < 400; i++) mod.Npcs.AddNew($"LongNPC{i}");
            })
            .Build();

    [Fact]
    public async Task DisposingTheIndexWhileItReadsAPlugin_StopsTheReadPartway()
    {
        using var fixture = LongPlugin("read-disposal");
        var holder = new LoadOrderHolder();
        var reading = new TaskCompletionSource();
        using var index = Indexes.Open(holder, new PartwayAdapter(
            afterRecords: 2, () => reading.TrySetResult(), thenEachRecordTakes: TimeSpan.FromMilliseconds(50)));
        holder.Apply(LoadOrderArrival.Snapshot(fixture.DataFolder, instanceRoot: null, GameRelease.Fallout4, fixture.Plugins));
        await reading.Task.WaitAsync(TimeSpan.FromSeconds(30));

        var disposing = Task.Run(index.Dispose);

        Assert.Same(disposing, await Task.WhenAny(disposing, Task.Delay(TimeSpan.FromSeconds(5))));
    }

    [Fact]
    public void ANewerSnapshotWhileItReadsAPlugin_LetsThatReadFinish()
    {
        using var fixture = LongPlugin("read-superseded");
        var holder = new LoadOrderHolder();
        var reads = 0;
        using var index = Indexes.Open(holder, new PartwayAdapter(
            afterRecords: 2,
            () => { if (Interlocked.Increment(ref reads) == 1) holder.Apply(holder.Current); },
            thenEachRecordTakes: TimeSpan.FromMilliseconds(10)));

        holder.Apply(LoadOrderArrival.Snapshot(fixture.DataFolder, instanceRoot: null, GameRelease.Fallout4, fixture.Plugins));
        Waits.Reached(
            () => index.Status.State != LoadOrderState.Reconciling && index.Status.IndexedPlugins.Any(p => p.Name == "Long.esp"),
            "Long.esp indexed");

        Assert.Equal(1, reads);
    }
}
