using MEditService.Index.Queries;
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
        Assert.Empty(world.ExteriorCells());
        Assert.Empty(world.InteriorCells());
        Assert.DoesNotContain(world.RecordTypes(), c => c.Type is "wrld" or "cell");
    }

    [Fact]
    public void AFilterMatchingAPlacedReference_KeepsTheCellAndWorldspaceHoldingIt_AndNoInteriorCell()
    {
        using var world = new FilteredWorld();

        world.Filter("SELECT form_key FROM records WHERE editor_id = 'FilterRef'");

        Assert.Equal(world.WorldspaceFormKey, Assert.Single(world.Worldspaces()).FormKey);
        Assert.Equal(world.ExteriorCellFormKey, Assert.Single(world.ExteriorCells()).FormKey);
        Assert.Empty(world.InteriorCells());
    }

    [Fact]
    public void AFilterMatchingOneInteriorCell_ListsThatCellAlone_AndCountsIt()
    {
        using var world = new FilteredWorld();

        world.Filter("SELECT form_key FROM records WHERE editor_id = 'FilterInterior'");

        Assert.Equal(world.InteriorCellFormKey, Assert.Single(world.InteriorCells()).FormKey);
        Assert.Empty(world.Worldspaces());
        Assert.Equal(1, Assert.Single(world.RecordTypes(), c => c.Type == "cell").Count);
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

        internal IReadOnlyList<WorldspaceSummary> Worldspaces() => _index.Worldspaces.GetWorldspaces(Plugin);

        internal IEnumerable<CellSummary> ExteriorCells()
        {
            var blocks = _index.Worldspaces.GetWorldspaceBlocks(Plugin, WorldspaceFormKey);
            return blocks.TopCells.Concat(blocks.Blocks.SelectMany(b => b.SubBlocks).SelectMany(s => s.Cells));
        }

        internal IEnumerable<CellSummary> InteriorCells() =>
            _index.Worldspaces.GetInteriorCells(Plugin).SelectMany(b => b.SubBlocks).SelectMany(s => s.Cells);

        internal IReadOnlyList<PluginRecordTypeCount> RecordTypes() => _index.Records.GetPluginRecordTypes(Plugin);

        public void Dispose()
        {
            _index.Dispose();
            _dataFolder.Dispose();
        }
    }
}
