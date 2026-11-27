using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Indexing;

public class PluginReadInterruptionTests
{
    private const int LongPluginRecords = 400;

    private static PluginFixtureData LongPlugin(string name) =>
        new PluginFixtureBuilder(name)
            .WithPlugin("Long.esp", mod =>
            {
                for (var i = 0; i < LongPluginRecords; i++) mod.Npcs.AddNew($"LongNPC{i}");
            })
            .Build();

    [Fact]
    public async Task DisposingTheIndexWhileItReadsAPlugin_StopsTheReadPartway()
    {
        using var fixture = LongPlugin("read-disposal");
        var log = new List<LogEntry>();
        using var loggers = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider(log)));
        var holder = new LoadOrderHolder();
        var reading = new TaskCompletionSource();
        var askedOnward = 0;
        using var index = Indexes.Open(holder, new PartwayAdapter(afterRecords: 2, () =>
        {
            reading.TrySetResult();
            Waits.Reached(() => { lock (log) return log.Exists(e => e.Message == "Asked the reconcile in flight to stop"); }, "the disposal asking the read to stop");
        }, thenEachRecord: () => askedOnward++), loggerFactory: loggers);
        holder.Apply(SnapshotPlugins.Snapshot(fixture.DataFolder, instanceRoot: null, GameRelease.Fallout4, fixture.Plugins));
        await reading.Task.WaitAsync(TimeSpan.FromSeconds(30));

        await Task.Run(index.Dispose).WaitAsync(Waits.Patience);

        Assert.True(askedOnward < LongPluginRecords - 2, $"The read asked for {askedOnward} records after the disposal began.");
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

            await Task.Delay(TimeSpan.FromMilliseconds(300));
            Assert.False(disposing.IsCompleted, "the close waiting for the read");
            clock.Advance(TimeSpan.FromSeconds(10));
            await disposing.WaitAsync(Waits.Patience);
        }
        finally
        {
            stuck.Set();
        }
    }

    [Fact]
    public void ANewerSnapshotWhileItReadsAPlugin_LetsThatReadFinish()
    {
        using var fixture = LongPlugin("read-newer-snapshot");
        var holder = new LoadOrderHolder();
        var reads = 0;
        var aNewerSnapshotOnTheFirstRead = Faults.InTurn(() => holder.Apply(holder.Current));
        using var index = Indexes.Open(holder, new PartwayAdapter(
            afterRecords: 2,
            () =>
            {
                Interlocked.Increment(ref reads);
                aNewerSnapshotOnTheFirstRead();
            }));

        holder.Apply(SnapshotPlugins.Snapshot(fixture.DataFolder, instanceRoot: null, GameRelease.Fallout4, fixture.Plugins));
        Waits.Reached(
            () => index.Status.State != LoadOrderState.Reconciling && index.Status.IndexedPlugins.Any(p => p.Name == "Long.esp"),
            "Long.esp indexed");

        Assert.Equal(1, reads);
    }

    [Theory]
    [InlineData(typeof(InvalidOperationException))]
    [InlineData(typeof(OperationCanceledException))]
    public void IndexingThatThrowsPartway_CommitsNoPartialRows(Type thrownType)
    {
        using var fixture = new PluginFixtureBuilder("index-atomicity")
            .WithPlugin("Atomic.esp", mod =>
            {
                mod.Npcs.AddNew("AtomicNPC1");
                mod.Npcs.AddNew("AtomicNPC2");
                mod.Npcs.AddNew("AtomicNPC3");
            })
            .Build();
        var key = new PluginAddress("Atomic.esp", PluginOrigin.DataDirectory);
        using var index = Indexes.Reconciled(fixture, adapter: new PartwayAdapter(
            afterRecords: 2, () => throw Faults.Of(thrownType)));

        Assert.Contains(index.Status.Failures, f => f.Name == "Atomic.esp");
        Assert.DoesNotContain(index.Status.IndexedPlugins, p => p.Name == "Atomic.esp");
        Assert.Equal(0, index.CountOf(key, "npc_"));
        Assert.Empty(index.ListedIn(key));
        Assert.Empty(index.Queries.GetRecords(["npc_"], plugin: null, search: null, limit: 10, offset: 0).Value().Items);
    }
}
