using MEditService.Codec.Schema;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Indexing;

public class FormLookupTests
{
    private static (string? RecordType, string? EditorId) Resolved(OpenedIndex index, FormKey npc, PluginAddress plugin, string target)
    {
        var resolution = index.ResolutionOf(npc.ToString(), plugin, target);
        return (resolution.RecordType, resolution.EditorId);
    }

    [Fact]
    public void TwoRecords_ResolveEachAndTheHeader()
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
        var key = new PluginAddress("Lookup.esp", PluginOrigin.DataDirectory);

        Assert.Equal(("npc_", "TestNPC01"), Resolved(index, npc, key, npc.ToString()));
        Assert.Equal(("race", "TestRace01"), Resolved(index, npc, key, race.ToString()));
        Assert.Equal<(string?, string?)>(
            (PluginHeader.RecordType, null),
            Resolved(index, npc, key, PluginHeader.FormKeyFor(ModKey.FromFileName("Lookup.esp"))));
        Assert.Equal(2, index.ListedIn(key).Count);
    }

    [Fact]
    public async Task ReindexingAPlugin_ReplacesItsLookupRowsRatherThanDuplicating()
    {
        FormKey npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-lookup-reindex")
            .WithPlugin("Reindex.esp", mod => npcFormKey = mod.Npcs.AddNew("TestNPC01").FormKey)
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var key = new PluginAddress("Reindex.esp", PluginOrigin.DataDirectory);
        var before = index.ListedIn(key).Count;

        PluginBinaries.Touch(fixture.Plugins.Single().Path);
        index.NextSnapshot();

        Assert.Equal(before, index.ListedIn(key).Count);
        Assert.Equal(1, index.Records.GetRecords(["npc_"], plugin: null, search: null, limit: 10, offset: 0).Value().Total);
        Assert.Equal(("npc_", "TestNPC01"), Resolved(index, npcFormKey, key, npcFormKey.ToString()));
    }
}
