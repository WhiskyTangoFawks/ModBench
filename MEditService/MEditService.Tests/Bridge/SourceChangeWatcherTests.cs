using System.Diagnostics;
using MEditService.Bridge;

namespace MEditService.Tests.Bridge;

/// <summary>ADR-0046 invariant 4: settling is watcher-wide, not per plugin. Any event on any watch
/// restarts one shared quiet timer, and a maximum window bounds the wait.</summary>
public sealed class SourceChangeWatcherTests
{
    private static string NewSourceRoot(string pluginName, out string modFolder)
    {
        modFolder = Directory.CreateTempSubdirectory("medit-coalesce-").FullName;
        var sourceRoot = Path.Combine(modFolder, "source", pluginName);
        Directory.CreateDirectory(sourceRoot);
        return sourceRoot;
    }

    private static void Write(string sourceRoot) =>
        File.WriteAllText(Path.Combine(sourceRoot, "record.json"), Guid.NewGuid().ToString());

    private static void WaitUntil(Func<bool> condition, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (condition()) return;
            Thread.Sleep(20);
        }
    }

    [Fact]
    public void WritesToTwoPlugins_WithinTheQuietWindow_SettleAsOneBatchNamingBoth()
    {
        var sourceA = NewSourceRoot("A.esp", out var modA);
        var sourceB = NewSourceRoot("B.esp", out var modB);
        try
        {
            var batches = new List<IReadOnlyList<SourceChangeEvent>>();
            using var watcher = new SourceChangeWatcher(TimeSpan.FromMilliseconds(200), TimeSpan.FromSeconds(5));
            watcher.SourceChanged = batch => { lock (batches) batches.Add(batch); };
            watcher.Watch(modA, sourceA, "A.esp", "OriginA");
            watcher.Watch(modB, sourceB, "B.esp", "OriginB");

            Write(sourceA);
            Thread.Sleep(50); // well inside the 200ms quiet window
            Write(sourceB);

            WaitUntil(() => batches.Count > 0, TimeSpan.FromSeconds(5));
            // Long enough that a wrongly-split second batch would have landed too.
            Thread.Sleep(400);

            List<IReadOnlyList<SourceChangeEvent>> snapshot;
            lock (batches) snapshot = [.. batches];
            var batch = Assert.Single(snapshot);
            Assert.Equal(2, batch.Count);
            Assert.Contains(batch, e => e.PluginName == "A.esp");
            Assert.Contains(batch, e => e.PluginName == "B.esp");
        }
        finally
        {
            Directory.Delete(modA, recursive: true);
            Directory.Delete(modB, recursive: true);
        }
    }

    [Fact]
    public void WritesToTwoPlugins_SpacedBeyondTheQuietWindow_SettleAsTwoBatches()
    {
        var sourceA = NewSourceRoot("A.esp", out var modA);
        var sourceB = NewSourceRoot("B.esp", out var modB);
        try
        {
            var batches = new List<IReadOnlyList<SourceChangeEvent>>();
            using var watcher = new SourceChangeWatcher(TimeSpan.FromMilliseconds(100), TimeSpan.FromSeconds(5));
            watcher.SourceChanged = batch => { lock (batches) batches.Add(batch); };
            watcher.Watch(modA, sourceA, "A.esp", "OriginA");
            watcher.Watch(modB, sourceB, "B.esp", "OriginB");

            Write(sourceA);
            WaitUntil(() => batches.Count == 1, TimeSpan.FromSeconds(5));

            Write(sourceB);
            WaitUntil(() => batches.Count == 2, TimeSpan.FromSeconds(5));

            List<IReadOnlyList<SourceChangeEvent>> snapshot;
            lock (batches) snapshot = [.. batches];
            Assert.Equal(2, snapshot.Count);
            Assert.Equal("A.esp", Assert.Single(snapshot[0]).PluginName);
            Assert.Equal("B.esp", Assert.Single(snapshot[1]).PluginName);
        }
        finally
        {
            Directory.Delete(modA, recursive: true);
            Directory.Delete(modB, recursive: true);
        }
    }

    [Fact]
    public void AStreamThatNeverGoesQuiet_StillSettlesAtTheMaximumWindow()
    {
        var sourceA = NewSourceRoot("A.esp", out var modA);
        try
        {
            var landedAt = new List<TimeSpan>();
            var stopwatch = Stopwatch.StartNew();
            using var watcher = new SourceChangeWatcher(TimeSpan.FromMilliseconds(100), TimeSpan.FromMilliseconds(400));
            watcher.SourceChanged = _ => { lock (landedAt) landedAt.Add(stopwatch.Elapsed); };
            watcher.Watch(modA, sourceA, "A.esp", "OriginA");

            // Every 50ms, well inside the 100ms quiet window, for well past the 400ms maximum: the
            // quiet timer alone would never fire.
            var deadline = DateTime.UtcNow + TimeSpan.FromMilliseconds(1200);
            while (DateTime.UtcNow < deadline)
            {
                Write(sourceA);
                Thread.Sleep(50);
            }

            WaitUntil(() => landedAt.Count > 0, TimeSpan.FromSeconds(5));
            List<TimeSpan> snapshot;
            lock (landedAt) snapshot = [.. landedAt];
            Assert.NotEmpty(snapshot);
            // Forced by the maximum window, well before the stream itself stopped at 1200ms.
            Assert.True(snapshot[0] < TimeSpan.FromMilliseconds(1000), $"first batch landed at {snapshot[0]}");
        }
        finally
        {
            Directory.Delete(modA, recursive: true);
        }
    }
}
