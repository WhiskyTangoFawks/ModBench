using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Indexing;

public class IndexAtomicityTests
{
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
