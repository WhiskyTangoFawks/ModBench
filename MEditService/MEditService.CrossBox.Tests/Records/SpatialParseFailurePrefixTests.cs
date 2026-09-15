using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Queries;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Records;

/// <summary>The worldspace chain's half of "anything with an error on it or below it carries the
/// prefix". Ingest's side has its own test against the real fixture.</summary>
public sealed class SpatialParseFailurePrefixTests
{
    [Fact]
    public void AnUnreadablePlacedReference_MarksItself_ItsCell_ItsBlocks_AndItsWorldspace()
    {
        using var world = new SpatialWorld();
        world.MarkUnreadable(world.PlacedFormKey);

        var placed = world.Query.GetCellReferences(SpatialWorld.PluginName, world.CellFormKey, SpatialWorld.Origin);
        var blocks = world.Query.GetWorldspaceBlocks(SpatialWorld.PluginName, world.WorldspaceFormKey, SpatialWorld.Origin);
        var worldspace = world.Query.GetWorldspaces(SpatialWorld.PluginName, SpatialWorld.Origin).Single();

        Assert.True(placed.Persistent.Single().HasParseFailure);
        var block = Assert.Single(blocks.Blocks);
        Assert.True(block.HasParseFailure);
        Assert.True(block.SubBlocks.Single().HasParseFailure);
        Assert.True(block.SubBlocks.Single().Cells.Single().HasParseFailure);
        Assert.True(worldspace.HasParseFailure);
    }

    [Fact]
    public void AReadableWorldspace_CarriesNoPrefixAnywhere()
    {
        using var world = new SpatialWorld();

        var placed = world.Query.GetCellReferences(SpatialWorld.PluginName, world.CellFormKey, SpatialWorld.Origin);
        var blocks = world.Query.GetWorldspaceBlocks(SpatialWorld.PluginName, world.WorldspaceFormKey, SpatialWorld.Origin);
        var worldspace = world.Query.GetWorldspaces(SpatialWorld.PluginName, SpatialWorld.Origin).Single();

        Assert.False(placed.Persistent.Single().HasParseFailure);
        Assert.False(blocks.Blocks.Single().HasParseFailure);
        Assert.False(blocks.Blocks.Single().SubBlocks.Single().Cells.Single().HasParseFailure);
        Assert.False(worldspace.HasParseFailure);
    }

    [Fact]
    public void AnUnreadableInteriorCell_MarksItsRowInTheInteriorListing()
    {
        using var world = new SpatialWorld();
        world.MarkUnreadable(world.InteriorCellFormKey);

        var interiors = world.Query.GetInteriorCells(SpatialWorld.PluginName, 50, 0, SpatialWorld.Origin);

        Assert.True(interiors.Items.Single(c => c.FormKey == world.InteriorCellFormKey).HasParseFailure);
    }

    private sealed class SpatialWorld : IDisposable
    {
        internal const string PluginName = "SpatialPrefix.esp";
        internal const string Origin = PluginOrigin.DataDirectory;

        private readonly string _dataFolder = Directory.CreateTempSubdirectory("medit-spatial-").FullName;
        private readonly IndexProjector _index;

        internal string WorldspaceFormKey { get; }
        internal string CellFormKey { get; }
        internal string PlacedFormKey { get; }
        internal string InteriorCellFormKey { get; }
        internal IWorldspaceQueryService Query { get; }

        internal SpatialWorld()
        {
            var holder = new LoadOrderHolder();
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
            var wrld = mod.Worldspaces.AddNew("PrefixWorld");
            var cell = new Cell(mod) { EditorID = "PrefixCell", Grid = new CellGrid { Point = new P2Int(1, 1) } };
            var placed = new PlacedObject(mod) { EditorID = "PrefixRef" };
            cell.Persistent.Add(placed);
            var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
            subBlock.Items.Add(cell);
            var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
            block.Items.Add(subBlock);
            wrld.SubCells.Add(block);

            var interior = new Cell(mod) { EditorID = "PrefixInterior" };
            var intSub = new CellSubBlock { BlockNumber = 0 };
            intSub.Cells.Add(interior);
            var intBlock = new CellBlock { BlockNumber = 0 };
            intBlock.SubBlocks.Add(intSub);
            mod.Cells.Records.Add(intBlock);

            WorldspaceFormKey = wrld.FormKey.ToString();
            CellFormKey = cell.FormKey.ToString();
            PlacedFormKey = placed.FormKey.ToString();
            InteriorCellFormKey = interior.FormKey.ToString();

            var path = Path.Combine(_dataFolder, PluginName);
            mod.WriteToBinary(path);

            _index = new IndexProjector(
                holder,
                MutagenPluginAdapter.Instance,
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            _index.Reconcile(holder,
                _dataFolder,
                [new LoadOrderEntry(PluginName, path, Origin, Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);

            Query = new WorldspaceQueryService(_index, holder);
        }

        internal void MarkUnreadable(string formKey)
        {
            using var cmd = ((DuckDbRecordIndex)_index.Store!).Connection.CreateCommand();
            cmd.CommandText = "UPDATE mirror.records SET parse_diagnosis = 'could not be read' WHERE form_key = $1";
            cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
            cmd.ExecuteNonQuery();
        }

        public void Dispose()
        {
            _index.Dispose();
            try { Directory.Delete(_dataFolder, recursive: true); } catch (IOException) { }
        }
    }
}
