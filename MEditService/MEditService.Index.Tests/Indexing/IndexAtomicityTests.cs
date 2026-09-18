using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Indexing;

// A plugin whose ingest throws partway lands no row at all: the copy is a failure on the status,
// and every read answers as if it were never indexed.
public class IndexAtomicityTests
{
    [Fact]
    public void Index_ThrowingPartway_CommitsNoPartialRows()
    {
        using var fixture = new PluginFixtureBuilder("index-atomicity")
            .WithPlugin("Atomic.esp", mod =>
            {
                mod.Npcs.AddNew("AtomicNPC1");
                mod.Npcs.AddNew("AtomicNPC2");
                mod.Npcs.AddNew("AtomicNPC3");
            })
            .Build();
        var key = new PluginCopyKey("Atomic.esp", "Data");
        using var index = Indexes.Reconciled(fixture, adapter: new ThrowingPartwayAdapter(afterRecords: 2));
        var reads = index.RequireReads();

        Assert.Contains(index.Status.Failures, f => f.Name == "Atomic.esp");
        Assert.DoesNotContain(index.Status.IndexedPlugins, p => p.Name == "Atomic.esp");
        Assert.Equal(0, reads.CountOf(key, "npc_"));
        Assert.Empty(reads.GetDocuments(key));
        Assert.Empty(reads.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10)).Items);
    }

    // Real documents up to a point, then the throw an unreadable record would raise mid-plugin.
    private sealed class ThrowingPartwayAdapter(int afterRecords) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override IPluginDocuments OpenDocuments(
            ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas,
            PluginStrings? strings = null) =>
            new ThrowingPartway(base.OpenDocuments(modPath, gameRelease, schemas, strings), afterRecords);
    }

    private sealed class ThrowingPartway(IPluginDocuments inner, int afterRecords) : IPluginDocuments
    {
        public PluginDocument Header => inner.Header;
        public IReadOnlyList<RecordTypeFailure> Failures => inner.Failures;

        public IEnumerable<PluginDocument> Records
        {
            get
            {
                var yielded = 0;
                foreach (var record in inner.Records)
                {
                    if (yielded++ == afterRecords) throw new InvalidOperationException("injected mid-plugin read failure");
                    yield return record;
                }
            }
        }

        public void Dispose() => inner.Dispose();
    }
}
