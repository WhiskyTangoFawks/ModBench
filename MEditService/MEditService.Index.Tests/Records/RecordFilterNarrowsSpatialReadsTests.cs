using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Index.Tests.Records;

public sealed class RecordFilterNarrowsSpatialReadsTests
{
    [Fact]
    public void AFilterMatchingNoSpatialRecord_ListsNoWorldspaceNorCell_AndCountsNeither()
    {
        using var world = new FilteredWorld();

        world.Filter("SELECT form_key FROM npc_");

        Assert.Empty(world.Worldspaces());
        Assert.Empty(world.Reads.GetWorldspacesHoldingCells(FilteredWorld.Plugin));
        Assert.Empty(world.Reads.GetWorldspaceCells(FilteredWorld.Plugin, world.WorldspaceFormKey));
        Assert.Empty(world.Reads.GetInteriorCells(FilteredWorld.Plugin));
        Assert.DoesNotContain(world.Reads.GetRecordTypeCounts(FilteredWorld.Plugin), c => c.Type is "wrld" or "cell");
    }

    [Fact]
    public void AFilterMatchingAPlacedReference_KeepsTheCellAndWorldspaceHoldingIt_AndNoInteriorCell()
    {
        using var world = new FilteredWorld();

        world.Filter("SELECT form_key FROM records WHERE editor_id = 'FilterRef'");

        Assert.Equal(world.WorldspaceFormKey, Assert.Single(world.Worldspaces()).FormKey);
        Assert.Equal(
            world.ExteriorCellFormKey,
            Assert.Single(world.Reads.GetWorldspaceCells(FilteredWorld.Plugin, world.WorldspaceFormKey)).FormKey);
        Assert.Empty(world.Reads.GetInteriorCells(FilteredWorld.Plugin));
    }

    [Fact]
    public void AFilterMatchingOneInteriorCell_ListsThatCellAlone_AndCountsIt()
    {
        using var world = new FilteredWorld();

        world.Filter("SELECT form_key FROM records WHERE editor_id = 'FilterInterior'");

        Assert.Equal(world.InteriorCellFormKey, Assert.Single(world.Reads.GetInteriorCells(FilteredWorld.Plugin)).FormKey);
        Assert.Empty(world.Worldspaces());
        Assert.Equal(1, Assert.Single(world.Reads.GetRecordTypeCounts(FilteredWorld.Plugin), c => c.Type == "cell").Count);
    }

    private sealed class FilteredWorld : IDisposable
    {
        private const string PluginName = "FilteredWorld.esp";

        internal static readonly PluginAddress Plugin = new(PluginName, PluginOrigin.DataDirectory);

        private readonly ScratchDirectory _dataFolder = new("medit-filtered-world-");
        private readonly OpenedIndex _index;

        internal string WorldspaceFormKey { get; }
        internal string ExteriorCellFormKey { get; }
        internal string InteriorCellFormKey { get; }
        internal IRecordReads Reads => _index.RequireReads();

        internal FilteredWorld()
        {
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("FilterNpc");

            var wrld = mod.Worldspaces.AddNew("FilterWorld");
            var exterior = new Cell(mod) { EditorID = "FilterExterior", Grid = new CellGrid { Point = new P2Int(1, 1) } };
            exterior.Persistent.Add(new PlacedObject(mod) { EditorID = "FilterRef" });
            var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
            subBlock.Items.Add(exterior);
            var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
            block.Items.Add(subBlock);
            wrld.SubCells.Add(block);

            var interior = new Cell(mod) { EditorID = "FilterInterior" };
            mod.Cells.Records.Add(InteriorBlock(0, interior));
            mod.Cells.Records.Add(InteriorBlock(1, new Cell(mod) { EditorID = "OtherInterior" }));

            WorldspaceFormKey = wrld.FormKey.ToString();
            ExteriorCellFormKey = exterior.FormKey.ToString();
            InteriorCellFormKey = interior.FormKey.ToString();

            var path = Path.Combine(_dataFolder, PluginName);
            mod.WriteToBinary(path);
            _index = Indexes.Reconciled(
                _dataFolder,
                [new LoadOrderEntry(PluginName, path, Plugin.Origin, Slot: 0, Enabled: true, Winning: true)]);
        }

        private static CellBlock InteriorBlock(int number, Cell cell)
        {
            var subBlock = new CellSubBlock { BlockNumber = number };
            subBlock.Cells.Add(cell);
            var block = new CellBlock { BlockNumber = number };
            block.SubBlocks.Add(subBlock);
            return block;
        }

        internal void Filter(string sql) => _index.SetFilter(sql, "filter.sql");

        internal IReadOnlyList<RecordSummary> Worldspaces() =>
            Reads.Search(new RecordQuery(
                RecordTypes: ["wrld"], Plugin: PluginName, Origin: Plugin.Origin, Limit: 100, GroupOnly: true)).Items;

        public void Dispose()
        {
            _index.Dispose();
            _dataFolder.Dispose();
        }
    }
}
