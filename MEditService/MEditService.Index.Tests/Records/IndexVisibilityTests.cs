using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
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
    private const int ConcurrentRequests = 4;

    [Fact]
    public async Task AReadDuringIndexing_NeverSeesAPartiallyIndexedPlugin()
    {
        using var fixture = new PluginFixtureBuilder("idx-vis")
            .WithPlugin("Big.esp", mod =>
            {
                for (int i = 0; i < NpcCount; i++) mod.Npcs.AddNew($"Npc{i:D4}");
            })
            .Build();
        var key = new PluginAddress("Big.esp", PluginOrigin.DataDirectory);
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);

        using var indexing = new CancellationTokenSource();

        var readers = Enumerable.Range(0, ConcurrentRequests).Select(_ => Task.Run(() =>
        {
            var tally = new ReadTally();
            while (!indexing.IsCancellationRequested)
                tally.Add(CountOrNone(index, key), index.Sequence);
            return tally;
        })).ToArray();

        index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4);
        await indexing.CancelAsync();
        var tallies = await Task.WhenAll(readers);

        var reads = tallies.Sum(t => t.Reads);
        Assert.True(reads > 50, $"only {reads} reads completed during indexing — reads are being blocked by it");
        Assert.Empty(tallies.SelectMany(t => t.PartialCounts));
        Assert.Equal(NpcCount, index.RequireReads().CountOf(key, "npc_"));
        var highestSequenceRead = tallies.Max(t => t.HighestSequence);
        Assert.True(highestSequenceRead <= index.Sequence,
            $"a read saw sequence {highestSequenceRead}, past the committed {index.Sequence}");
    }

    private sealed class ReadTally
    {
        public int Reads { get; private set; }
        public List<int> PartialCounts { get; } = [];
        public long HighestSequence { get; private set; }

        public void Add(int count, long sequence)
        {
            Reads++;
            if (count is not (0 or NpcCount)) PartialCounts.Add(count);
            HighestSequence = Math.Max(HighestSequence, sequence);
        }
    }

    // No store yet is a count of nothing, which is what a reader before the reconcile sees.
    private static int CountOrNone(Indexer index, PluginAddress key)
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
