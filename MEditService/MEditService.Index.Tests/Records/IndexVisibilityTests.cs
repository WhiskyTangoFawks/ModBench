using System.Collections.Concurrent;
using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Records;

/// <summary>An in-between count is the failure (ADR-0013): a plugin reading as "412 records" while
/// 1,588 are still being written is worse than absent, since nothing distinguishes it from one that
/// genuinely holds 412.</summary>
public sealed class IndexVisibilityTests
{
    // Ingest reads no live object per column any more, so the window a read can land in is the
    // codec serialize alone; enough records keep it long enough to sample.
    private const int NpcCount = 4000;

    [Fact]
    public async Task AReadDuringIndexing_NeverSeesAPartiallyIndexedPlugin()
    {
        using var fixture = new PluginFixtureBuilder("idx-vis")
            .WithPlugin("Big.esp", mod =>
            {
                for (int i = 0; i < NpcCount; i++) mod.Npcs.AddNew($"Npc{i:D4}");
            })
            .Build();
        var key = new PluginCopyKey("Big.esp", PluginOrigin.DataDirectory);
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);

        var counts = new ConcurrentBag<int>();
        var sequences = new ConcurrentQueue<long>();
        using var indexing = new CancellationTokenSource();

        // Several readers, because production is several concurrent HTTP requests, not one.
        var readers = Enumerable.Range(0, 4).Select(_ => Task.Run(() =>
        {
            while (!indexing.IsCancellationRequested)
            {
                counts.Add(CountOrNone(index, key));
                sequences.Enqueue(index.Sequence);
            }
        })).ToArray();

        index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4);
        await indexing.CancelAsync();
        await Task.WhenAll(readers);

        // If reads ever block behind the indexer's transaction the sample count collapses and the assertion
        // below starts passing for the wrong reason. It also is the "reads are served throughout the load"
        // property, measured where it originates.
        Assert.True(counts.Count > 50, $"only {counts.Count} reads completed during indexing — reads are being blocked by it");

        // Sound in one direction only: an intermediate count can be missed, but one that is seen is always
        // a real defect. This can fail to catch a regression; it cannot report one that is not there.
        Assert.All(counts, count => Assert.True(
            count is 0 or NpcCount,
            $"a read observed {count} of {NpcCount} records — a partially-indexed plugin was visible"));
        Assert.Equal(NpcCount, index.RequireReads().CountOf(key, "npc_"));

        // The sequence answers from the committed index too: before or after the ingest, never a
        // value of its own.
        Assert.All(sequences, sequence => Assert.True(sequence <= index.Sequence));
    }

    // No store yet is a count of nothing, which is what a reader before the reconcile sees.
    private static int CountOrNone(IndexProjector index, PluginCopyKey key)
    {
        try
        {
            return index.RequireReads().CountOf(key, "npc_");
        }
        catch (NoLoadOrderException)
        {
            return 0;
        }
    }
}
