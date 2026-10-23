using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.RecordIndex.Tests.Indexing;

public class PlacementIndexingTests
{
    private static PluginFixtureData OneWorldspaceCell(string prefix, string plugin, out FormKey cellKey, out FormKey placedKey, out FormKey worldspaceKey)
    {
        FormKey cell = default, placed = default, wrld = default;
        var fixture = new PluginFixtureBuilder(prefix)
            .WithPlugin(plugin, mod =>
            {
                var w = mod.Worldspaces.AddNew("OverlayWrld");
                var c = new Cell(mod) { EditorID = "OverlayCell", Grid = new CellGrid { Point = new P2Int(3, 4) } };
                var p = new PlacedObject(mod) { EditorID = "overlayRef", Position = new P3Float(7f, 8f, 9f) };
                c.Persistent.Add(p);
                var sub = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                sub.Items.Add(c);
                var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                block.Items.Add(sub);
                w.SubCells.Add(block);
                (cell, placed, wrld) = (c.FormKey, p.FormKey, w.FormKey);
            })
            .Build();
        (cellKey, placedKey, worldspaceKey) = (cell, placed, wrld);
        return fixture;
    }

    [Fact]
    public void ReindexingAPlugin_ReplacesItsCellsAndPlacementsRatherThanDuplicating()
    {
        using var fixture = OneWorldspaceCell("placement-reindex", "ReindexPlacement.esp", out var cell, out var placed, out var wrld);
        using var index = Indexes.Reconciled(fixture);
        var key = new PluginAddress("ReindexPlacement.esp", PluginOrigin.DataDirectory);

        PluginBinaries.Touch(fixture.Plugins.Single().Path);
        index.NextSnapshot();

        var blocks = index.Queries.GetWorldspaceBlocks(key, wrld.ToString()).Value();
        Assert.Single(blocks.Blocks.SelectMany(b => b.SubBlocks).SelectMany(s => s.Cells), c => c.FormKey == cell.ToString());
        Assert.Single(index.Queries.GetCellChildRecords(key, cell.ToString()).Value().Persistent, p => p.FormKey == placed.ToString());
    }

    [Fact]
    public void PlacedObjects_AreAlsoIndexedAsRefrRecords()
    {
        using var fixture = OneWorldspaceCell("placement-refr", "RefrPlacement.esp", out _, out var placed, out _);
        using var index = Indexes.Reconciled(fixture);
        var key = new PluginAddress("RefrPlacement.esp", PluginOrigin.DataDirectory);

        Assert.Single(index.Queries.GetRecords(["refr"], key, search: placed.ToString(), limit: 10, offset: 0).Value().Items);
    }
}
