using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Records;

/// <summary>The worldspace chain's half of "anything with an error on it or below it carries the
/// prefix", at the reads the tree listings are built from. Ingest's side has its own test against
/// the real fixture.</summary>
public sealed class SpatialParseFailurePrefixTests
{
    [Fact]
    public void AnUnreadablePlacedReference_MarksItself_ItsCell_AndItsWorldspace()
    {
        using var world = new SpatialWorld();
        world.MarkUnreadable(world.PlacedFormKey);

        var placed = world.Reads.GetCellReferences(SpatialWorld.Plugin, world.CellFormKey);
        var cells = world.Reads.GetWorldspaceCells(SpatialWorld.Plugin, world.WorldspaceFormKey);

        Assert.True(placed.Persistent.Single().HasParseFailure);
        Assert.True(cells.Single().HasParseFailure);
        Assert.Contains(
            world.WorldspaceFormKey, world.Reads.GetWorldspacesWithFailuresBelow(SpatialWorld.Plugin));
    }

    [Fact]
    public void AReadableWorldspace_CarriesNoPrefixAnywhere()
    {
        using var world = new SpatialWorld();

        var placed = world.Reads.GetCellReferences(SpatialWorld.Plugin, world.CellFormKey);
        var cells = world.Reads.GetWorldspaceCells(SpatialWorld.Plugin, world.WorldspaceFormKey);

        Assert.False(placed.Persistent.Single().HasParseFailure);
        Assert.False(cells.Single().HasParseFailure);
        Assert.Empty(world.Reads.GetWorldspacesWithFailuresBelow(SpatialWorld.Plugin));
    }

    // The worldspace itself is a record the listing reads: the worldspace row is only reachable at
    // all because ingest indexed it beside its cells.
    [Fact]
    public void AWorldspace_IsListedWithItsCellsBelowIt()
    {
        using var world = new SpatialWorld();

        var worldspaces = world.Reads
            .Search(new RecordQuery(RecordTypes: ["wrld"], Plugin: SpatialWorld.PluginName, Limit: 100)).Items;

        Assert.Equal(world.WorldspaceFormKey, Assert.Single(worldspaces).FormKey);
        Assert.Equal(
            world.CellFormKey,
            Assert.Single(world.Reads.GetWorldspaceCells(SpatialWorld.Plugin, world.WorldspaceFormKey)).FormKey);
    }

    [Fact]
    public void AnUnreadableInteriorCell_MarksItsRowInTheInteriorListing()
    {
        using var world = new SpatialWorld();
        world.MarkUnreadable(world.InteriorCellFormKey);

        var interiors = world.Reads.GetInteriorCells(SpatialWorld.Plugin, 50, 0);

        Assert.True(interiors.Items.Single(c => c.FormKey == world.InteriorCellFormKey).HasParseFailure);
    }

    private sealed class SpatialWorld : IDisposable
    {
        internal const string PluginName = "SpatialPrefix.esp";
        internal const string Origin = PluginOrigin.DataDirectory;

        internal static readonly PluginCopyKey Plugin = new(PluginName, Origin);

        private readonly string _dataFolder = Directory.CreateTempSubdirectory("medit-spatial-").FullName;
        private readonly string _path;
        private readonly DiagnosingAdapter _adapter = new();
        private readonly IndexProjector _index;

        internal string WorldspaceFormKey { get; }
        internal string CellFormKey { get; }
        internal string PlacedFormKey { get; }
        internal string InteriorCellFormKey { get; }
        internal IRecordReads Reads => _index.RequireReads();

        internal SpatialWorld()
        {
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

            _path = Path.Combine(_dataFolder, PluginName);
            mod.WriteToBinary(_path);

            _index = Indexes.Reconciled(
                _dataFolder,
                [new LoadOrderEntry(PluginName, _path, Origin, Slot: 0, Enabled: true, Winning: true)],
                adapter: _adapter);
        }

        // The record's document arrives as an identity-only stub carrying a diagnosis, the shape
        // the adapter hands over for a record it could not read, and the copy is re-derived.
        internal void MarkUnreadable(string formKey)
        {
            _adapter.Unreadable = formKey;
            PluginBinaries.Touch(_path);
            Assert.True(_index.RefreshBinary(Plugin, _path).GetAwaiter().GetResult());
        }

        public void Dispose()
        {
            _index.Dispose();
            try { Directory.Delete(_dataFolder, recursive: true); } catch (IOException) { }
        }
    }

    private sealed class DiagnosingAdapter() : DelegatingPluginAdapter(MutagenPluginAdapter.Instance)
    {
        public string? Unreadable { get; set; }

        public override IPluginDocuments OpenDocuments(
            ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas,
            PluginStrings? strings = null) =>
            new Diagnosed(base.OpenDocuments(modPath, gameRelease, schemas, strings), Unreadable);
    }

    private sealed class Diagnosed(IPluginDocuments inner, string? unreadable) : IPluginDocuments
    {
        public PluginDocument Header => inner.Header;
        public IReadOnlyList<RecordTypeFailure> Failures => inner.Failures;

        public IEnumerable<PluginDocument> Records => inner.Records.Select(record =>
            record.FormKey == unreadable
                ? record with { Text = $"{{\"FormKey\": \"{record.FormKey}\"}}", ParseDiagnosis = "could not be read" }
                : record);

        public void Dispose() => inner.Dispose();
    }
}
