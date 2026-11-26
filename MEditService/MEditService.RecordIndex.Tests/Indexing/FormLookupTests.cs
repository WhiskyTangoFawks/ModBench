using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.RecordIndex.Tests.Indexing;

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
    public void ReindexingAPlugin_ReplacesEachOfItsRowsRatherThanDuplicating()
    {
        FormKey npc = default, race = default, world = default, cell = default, placed = default;
        using var fixture = new PluginFixtureBuilder("reindex")
            .WithPlugin("Reindex.esp", mod =>
            {
                race = mod.Races.AddNew("TestRace01").FormKey;
                var n = mod.Npcs.AddNew("TestNPC01");
                n.Race.SetTo(race);
                var w = mod.Worldspaces.AddNew("World");
                var c = new Cell(mod) { EditorID = "Cell", Grid = new CellGrid { Point = new P2Int(3, 4) } };
                var p = new PlacedObject(mod) { EditorID = "Placed" };
                c.Persistent.Add(p);
                var sub = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                sub.Items.Add(c);
                var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                block.Items.Add(sub);
                w.SubCells.Add(block);
                (npc, world, cell, placed) = (n.FormKey, w.FormKey, c.FormKey, p.FormKey);
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var key = new PluginAddress("Reindex.esp", PluginOrigin.DataDirectory);
        var listed = index.ListedIn(key).Count;

        PluginBinaries.Touch(fixture.Plugins.Single().Path);
        index.NextCheck();

        Assert.Equal(listed, index.ListedIn(key).Count);
        Assert.Single(index.StackOf(PluginHeader.FormKeyFor(ModKey.FromFileName(key.Name))));
        Assert.Equal(("npc_", "TestNPC01"), Resolved(index, npc, key, npc.ToString()));
        Assert.Single(index.Queries.GetReferencesInActiveOrCompiledPlugins(race.ToString()).Value());
        var blocks = index.Queries.GetWorldspaceBlocks(key, world.ToString()).Value();
        Assert.Single(blocks.Blocks.SelectMany(b => b.SubBlocks).SelectMany(s => s.Cells), c => c.FormKey == cell.ToString());
        Assert.Single(index.Queries.GetCellChildRecords(key, cell.ToString()).Value().Persistent, p => p.FormKey == placed.ToString());
    }
}
