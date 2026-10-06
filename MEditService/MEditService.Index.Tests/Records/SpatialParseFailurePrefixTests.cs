using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Index.Tests.Records;

public sealed class SpatialParseFailurePrefixTests
{
    [Fact]
    public void AnUnreadablePlacedReference_MarksItself_ItsCell_AndItsWorldspace()
    {
        using var world = new SpatialWorld();
        world.MarkUnreadable(world.PlacedFormKey);

        var placed = world.Reads.GetCellChildRecords(SpatialWorld.Plugin, world.CellFormKey);
        var cells = world.Reads.GetWorldspaceCells(SpatialWorld.Plugin, world.WorldspaceFormKey);

        Assert.True(placed.Persistent.Single().HasParseFailure);
        Assert.True(cells.Single().HasParseFailure);
        Assert.True(world.Row("wrld").HasParseFailure);
    }

    [Fact]
    public void AnUnreadableResponse_MarksItsTopic_AndTheQuestAboveIt()
    {
        using var world = new SpatialWorld();
        world.MarkUnreadable(world.ResponseFormKey);

        Assert.True(world.Row("dial").HasParseFailure);
        Assert.True(world.Row("qust").HasParseFailure);
    }

    [Fact]
    public void AnUnreadablePlacedReference_MarksTheGroupOfTheRecordItSitsBeneath_AndNoOther()
    {
        using var world = new SpatialWorld();
        world.MarkUnreadable(world.PlacedFormKey);

        var groups = world.Reads.GetRecordTypeCounts(SpatialWorld.Plugin).ToDictionary(g => g.Type, g => g.HasParseFailure);

        Assert.True(groups["wrld"]);
        Assert.False(groups["cell"]);
    }

    [Fact]
    public void AnUnreadablePlacedReference_CarriesItsReason_AndItsCellCarriesNone()
    {
        using var world = new SpatialWorld();
        world.MarkUnreadable(world.PlacedFormKey);

        var placed = world.Reads.GetCellChildRecords(SpatialWorld.Plugin, world.CellFormKey);
        var cells = world.Reads.GetWorldspaceCells(SpatialWorld.Plugin, world.WorldspaceFormKey);

        Assert.Equal("could not be read", placed.Persistent.Single().ParseDiagnosis);
        Assert.Null(cells.Single().ParseDiagnosis);
    }

    [Fact]
    public void AnUnreadableExteriorCell_CarriesItsReason()
    {
        using var world = new SpatialWorld();
        world.MarkUnreadable(world.CellFormKey);

        var cells = world.Reads.GetWorldspaceCells(SpatialWorld.Plugin, world.WorldspaceFormKey);

        Assert.Equal("could not be read", cells.Single().ParseDiagnosis);
    }

    [Fact]
    public void AReadableWorldspace_CarriesNoPrefixAnywhere()
    {
        using var world = new SpatialWorld();

        var placed = world.Reads.GetCellChildRecords(SpatialWorld.Plugin, world.CellFormKey);
        var cells = world.Reads.GetWorldspaceCells(SpatialWorld.Plugin, world.WorldspaceFormKey);

        Assert.False(placed.Persistent.Single().HasParseFailure);
        Assert.False(cells.Single().HasParseFailure);
        Assert.False(world.Row("wrld").HasParseFailure);
        Assert.False(world.Row("qust").HasParseFailure);
    }

    [Fact]
    public void AWorldspace_IsListedWithItsCellsBelowIt()
    {
        using var world = new SpatialWorld();

        var worldspaces = world.Reads
            .Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["wrld"], Plugin: SpatialWorld.PluginName, Limit: 100)).Items;

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

        var interiors = world.Reads.GetInteriorCells(SpatialWorld.Plugin);

        var interior = interiors.Single(c => c.FormKey == world.InteriorCellFormKey);
        Assert.True(interior.HasParseFailure);
        Assert.Equal("could not be read", interior.ParseDiagnosis);
    }

    private sealed class SpatialWorld : IDisposable
    {
        internal const string PluginName = "SpatialPrefix.esp";
        internal const string Origin = PluginOrigin.DataDirectory;

        internal static readonly PluginAddress Plugin = new(PluginName, Origin);

        private readonly ScratchDirectory _dataFolder = new("medit-spatial-");
        private readonly string _path;
        private readonly DiagnosingAdapter _adapter = new();
        private readonly OpenedIndex _index;

        internal string WorldspaceFormKey { get; }
        internal string CellFormKey { get; }
        internal string PlacedFormKey { get; }
        internal string InteriorCellFormKey { get; }
        internal string ResponseFormKey { get; }
        internal IRecordReads Reads => _index.RequireReads();

        internal RecordSummary Row(string recordType) =>
            Assert.Single(Reads.Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: [recordType], Plugin: PluginName, Limit: 100)).Items);

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

            var response = new DialogResponses(mod) { EditorID = "PrefixResponse" };
            var topic = new DialogTopic(mod) { EditorID = "PrefixTopic" };
            topic.Responses.Add(response);
            var quest = new Quest(mod) { EditorID = "PrefixQuest" };
            quest.DialogTopics.Add(topic);
            mod.Quests.Add(quest);

            WorldspaceFormKey = wrld.FormKey.ToString();
            ResponseFormKey = response.FormKey.ToString();
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

        internal void MarkUnreadable(string formKey)
        {
            _adapter.Unreadable = formKey;
            PluginBinaries.Touch(_path);
            _index.NextSnapshot();
        }

        public void Dispose()
        {
            _index.Dispose();
            _dataFolder.Dispose();
        }
    }

    private sealed class DiagnosingAdapter() : DelegatingPluginAdapter(TestAdapters.Mutagen())
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
