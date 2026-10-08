using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Indexing;

public class IndexAtomicityTests
{
    [Fact]
    public void IndexingThatThrowsPartway_CommitsNoPartialRows()
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
            afterRecords: 2, () => throw new InvalidOperationException("injected mid-plugin read failure")));
        var reads = index.RequireReads();

        Assert.Contains(index.Status.Failures, f => f.Name == "Atomic.esp");
        Assert.DoesNotContain(index.Status.IndexedPlugins, p => p.Name == "Atomic.esp");
        Assert.Equal(0, reads.CountOf(key, "npc_"));
        Assert.Empty(reads.DocumentsOf(key));
        Assert.Empty(reads.Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"], Limit: 10)).Items);
    }
}
