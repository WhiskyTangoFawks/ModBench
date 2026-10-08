using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Records;

public sealed class IndexVisibilityTests
{
    private const int RecordsPerIngestBatch = 2048;
    private const int NpcCount = RecordsPerIngestBatch + 1;
    private static readonly TimeSpan ReadBound = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan PauseBound = TimeSpan.FromSeconds(30);

    [Fact]
    public async Task AReadDuringIndexing_IsServed_AndNeverSeesAPartiallyIndexedPlugin()
    {
        using var fixture = new PluginFixtureBuilder("idx-vis")
            .WithPlugin("Big.esp", mod =>
            {
                for (int i = 0; i < NpcCount; i++) mod.Npcs.AddNew($"Npc{i:D4}");
            })
            .Build();
        var key = new PluginAddress("Big.esp", PluginOrigin.DataDirectory);
        var holder = new LoadOrderHolder();
        using var ingestPaused = new SemaphoreSlim(0, 1);
        using var ingestResumed = new SemaphoreSlim(0, 1);
        using var index = Indexes.Open(holder, new PartwayAdapter(afterRecords: RecordsPerIngestBatch, () =>
        {
            ingestPaused.Release();
            _ = ingestResumed.Wait(PauseBound);
        }));

        var reconcile = Task.Run(() => index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4));
        Assert.True(await ingestPaused.WaitAsync(PauseBound), "the ingest never reached the plugin's last record");
        var readMidIngest = Task.Run(() => (Npcs: index.CountOf(key, "npc_"), index.Sequence));
        var servedMidIngest = await Waits.CompletesWithin(readMidIngest, ReadBound);
        ingestResumed.Release();
        await reconcile;

        Assert.True(servedMidIngest,
            $"a read made while the plugin was being indexed did not complete within {ReadBound.TotalSeconds} s: reads are blocked by the ingest");
        var (npcsMidIngest, sequenceMidIngest) = await readMidIngest;
        Assert.True(npcsMidIngest == 0,
            $"a read made while the plugin was being indexed saw {npcsMidIngest} of its {NpcCount} NPCs");
        Assert.Equal(NpcCount, index.CountOf(key, "npc_"));
        Assert.True(sequenceMidIngest == 0,
            $"a read made while the plugin was being indexed saw sequence {sequenceMidIngest}, though nothing had landed");
    }
}
