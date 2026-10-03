using MEditService.Codec.Schema;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Indexing;

public class FormLookupTests
{
    [Fact]
    public void Index_TwoRecords_ResolvesEachAndTheHeader()
    {
        FormKey npc = default, race = default;
        using var fixture = new PluginFixtureBuilder("form-lookup-population")
            .WithPlugin("Lookup.esp", mod =>
            {
                npc = mod.Npcs.AddNew("TestNPC01").FormKey;
                race = mod.Races.AddNew("TestRace01").FormKey;
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();

        Assert.Equal(new RecordLookupEntry("npc_", "TestNPC01"), reads.Resolve(npc.ToString()));
        Assert.Equal(new RecordLookupEntry("race", "TestRace01"), reads.Resolve(race.ToString()));

        var header = reads.Resolve(PluginHeader.FormKeyFor(ModKey.FromFileName("Lookup.esp")));
        Assert.NotNull(header);
        Assert.Equal(PluginHeader.RecordType, header.Value.RecordType);
        Assert.Null(header.Value.EditorId);
        Assert.Equal(3, reads.GetDocuments(new PluginAddress("Lookup.esp", "Data")).Count);
    }

    [Fact]
    public async Task Index_ReIndexSamePlugin_ReplacesRatherThanDuplicates()
    {
        FormKey npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-lookup-reindex")
            .WithPlugin("Reindex.esp", mod => npcFormKey = mod.Npcs.AddNew("TestNPC01").FormKey)
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var key = new PluginAddress("Reindex.esp", "Data");
        var reads = index.RequireReads();
        var before = reads.GetDocuments(key).Count;

        PluginBinaries.Touch(fixture.Plugins.Single().Path);
        Assert.True(index.Revalidate());

        Assert.Equal(before, reads.GetDocuments(key).Count);
        Assert.Equal(1, reads.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10)).Total);
        Assert.Equal(new RecordLookupEntry("npc_", "TestNPC01"), reads.Resolve(npcFormKey.ToString()));
    }
}
