using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
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
        holder.Apply(SnapshotPlugins.Snapshot(fixture.DataFolder, instanceRoot: null, GameRelease.Fallout4, fixture.Plugins));
        await reading.Task.WaitAsync(TimeSpan.FromSeconds(30));

        var disposing = Task.Run(index.Dispose);

        Assert.Same(disposing, await Task.WhenAny(disposing, Task.Delay(TimeSpan.FromSeconds(5))));
    }

    [Fact]
    public async Task DisposingTheIndexWhileAReadIgnoresIt_WaitsForTheRead_OnlyUntilTheCloseLimit()
    {
        using var fixture = LongPlugin("read-ignores-disposal");
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var holder = new LoadOrderHolder();
        var reading = new TaskCompletionSource();
        using var stuck = new ManualResetEventSlim();
        using var index = Indexes.Open(holder, new PartwayAdapter(afterRecords: 2, () =>
        {
            reading.TrySetResult();
            stuck.Wait(TimeSpan.FromMinutes(1));
        }), timeProvider: clock);
        try
        {
            holder.Apply(SnapshotPlugins.Snapshot(fixture.DataFolder, instanceRoot: null, GameRelease.Fallout4, fixture.Plugins));
            await reading.Task.WaitAsync(TimeSpan.FromSeconds(30));

            var disposing = Task.Run(index.Dispose);

            Assert.False(await Waits.CompletesWithin(disposing, TimeSpan.FromMilliseconds(300)), "the close waiting for the read");
            clock.Advance(TimeSpan.FromSeconds(10));
            Assert.True(await Waits.CompletesWithin(disposing, TimeSpan.FromSeconds(5)), "the close returning once its limit passed");
        }
        finally
        {
            stuck.Set();
        }
    }

    [Fact]
    public void ANewerSnapshotWhileItReadsAPlugin_LetsThatReadFinish()
    {
        using var fixture = LongPlugin("read-superseded");
        var holder = new LoadOrderHolder();
        var reads = 0;
        var aNewerSnapshotOnTheFirstRead = Faults.InTurn(() => holder.Apply(holder.Current));
        using var index = Indexes.Open(holder, new PartwayAdapter(
            afterRecords: 2,
            () =>
            {
                Interlocked.Increment(ref reads);
                aNewerSnapshotOnTheFirstRead();
            },
            thenEachRecordTakes: TimeSpan.FromMilliseconds(10)));

        holder.Apply(SnapshotPlugins.Snapshot(fixture.DataFolder, instanceRoot: null, GameRelease.Fallout4, fixture.Plugins));
        Waits.Reached(
            () => index.Status.State != LoadOrderState.Reconciling && index.Status.IndexedPlugins.Any(p => p.Name == "Long.esp"),
            "Long.esp indexed");

        Assert.Equal(1, reads);
    }
}
