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
            // Quiet is far longer than both the write cadence and the maximum window, so only the
            // maximum window can force a settle before the stream stops — an overshooting Sleep
            // between writes still falls nowhere near 1500ms.
            using var watcher = new SourceChangeWatcher(TimeSpan.FromMilliseconds(1500), TimeSpan.FromMilliseconds(300));
            watcher.SourceChanged = _ => { lock (landedAt) landedAt.Add(stopwatch.Elapsed); };
            watcher.Watch(modA, sourceA, "A.esp", "OriginA");

            var deadline = DateTime.UtcNow + TimeSpan.FromMilliseconds(900);
            while (DateTime.UtcNow < deadline)
            {
                Write(sourceA);
                Thread.Sleep(50);
            }

            WaitUntil(() => landedAt.Count > 0, TimeSpan.FromSeconds(5));
            List<TimeSpan> snapshot;
            lock (landedAt) snapshot = [.. landedAt];
            Assert.NotEmpty(snapshot);
            // Forced by the maximum window during the still-active stream, not by quiet after it
            // stopped at 900ms — quiet alone could not land before ~2400ms.
            Assert.True(snapshot[0] < TimeSpan.FromMilliseconds(700), $"first batch landed at {snapshot[0]}");
        }
        finally
        {
            Directory.Delete(modA, recursive: true);
        }
    }
}
