using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
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

        var placed = world.Index.Worldspaces.GetCellChildRecords(SpatialWorld.Plugin, world.CellFormKey).Value();
        var cells = world.ExteriorCells();

        Assert.True(placed.Persistent.Single().HasParseFailure);
        Assert.True(cells.Single().HasParseFailure);
        Assert.True(world.Row("wrld").HasParseFailure);
    }

    [Fact]
    public void AnUnreadableResponse_MarksItsTopic_AndTheQuestAboveIt()
    {
        using var world = new SpatialWorld();
        world.MarkUnreadable(world.ResponseFormKey);

        Assert.True(Assert.Single(world.Index.Containers.GetChildren(SpatialWorld.Plugin, world.QuestFormKey).Value()).HasParseFailure);
        Assert.True(world.Row("qust").HasParseFailure);
    }

    [Fact]
    public void AnUnreadablePlacedReference_MarksTheGroupOfTheRecordItSitsBeneath_AndNoOther()
    {
        using var world = new SpatialWorld();
        world.MarkUnreadable(world.PlacedFormKey);

        var groups = world.Index.Records.GetPluginRecordTypes(SpatialWorld.Plugin).Value().ToDictionary(g => g.Type, g => g.HasParseFailure);

        Assert.True(groups["wrld"]);
        Assert.False(groups["cell"]);
    }

    [Fact]
    public void AnUnreadablePlacedReference_CarriesItsReason_AndItsCellCarriesNone()
    {
        using var world = new SpatialWorld();
        world.MarkUnreadable(world.PlacedFormKey);

        var placed = world.Index.Worldspaces.GetCellChildRecords(SpatialWorld.Plugin, world.CellFormKey).Value();
        var cells = world.ExteriorCells();

        Assert.Equal("could not be read", placed.Persistent.Single().ParseDiagnosis);
        Assert.Null(cells.Single().ParseDiagnosis);
    }

    [Fact]
    public void AnUnreadableExteriorCell_CarriesItsReason()
    {
        using var world = new SpatialWorld();
        world.MarkUnreadable(world.CellFormKey);

        var cells = world.ExteriorCells();

        Assert.Equal("could not be read", cells.Single().ParseDiagnosis);
    }

    [Fact]
    public void AReadableWorldspace_CarriesNoPrefixAnywhere()
    {
        using var world = new SpatialWorld();

        var placed = world.Index.Worldspaces.GetCellChildRecords(SpatialWorld.Plugin, world.CellFormKey).Value();
        var cells = world.ExteriorCells();

        Assert.False(placed.Persistent.Single().HasParseFailure);
        Assert.False(cells.Single().HasParseFailure);
        Assert.False(world.Row("wrld").HasParseFailure);
        Assert.False(world.Row("qust").HasParseFailure);
    }

    [Fact]
    public void AWorldspace_IsListedWithItsCellsBelowIt()
    {
        using var world = new SpatialWorld();

        Assert.Equal(world.WorldspaceFormKey, world.Row("wrld").FormKey);
        Assert.Equal(world.CellFormKey, Assert.Single(world.ExteriorCells()).FormKey);
    }

    [Fact]
    public void AnUnreadableInteriorCell_MarksItsRowInTheInteriorListing()
    {
        using var world = new SpatialWorld();
        world.MarkUnreadable(world.InteriorCellFormKey);

        var interior = world.Index.Worldspaces.GetInteriorCells(SpatialWorld.Plugin).Value()
            .SelectMany(block => block.SubBlocks).SelectMany(subBlock => subBlock.Cells)
            .Single(c => c.FormKey == world.InteriorCellFormKey);
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

        internal string WorldspaceFormKey { get; }
        internal string CellFormKey { get; }
        internal string PlacedFormKey { get; }
        internal string InteriorCellFormKey { get; }
        internal string ResponseFormKey { get; }
        internal string QuestFormKey { get; }
        internal OpenedIndex Index { get; }

        internal RecordSummary Row(string recordType) =>
            Assert.Single(Index.Records.GetRecords([recordType], Plugin, search: null, limit: 100, offset: 0).Value().Items);

        internal IReadOnlyList<CellSummary> ExteriorCells() =>
            [.. Index.Worldspaces.GetWorldspaceBlocks(Plugin, WorldspaceFormKey).Value().Blocks
                .SelectMany(block => block.SubBlocks).SelectMany(subBlock => subBlock.Cells)];

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
            QuestFormKey = quest.FormKey.ToString();
            CellFormKey = cell.FormKey.ToString();
            PlacedFormKey = placed.FormKey.ToString();
            InteriorCellFormKey = interior.FormKey.ToString();

            _path = Path.Combine(_dataFolder, PluginName);
            mod.WriteToBinary(_path);

            Index = Indexes.Reconciled(
                _dataFolder,
                [new LoadOrderEntry(PluginName, _path, Origin, Line: 0, Enabled: true, Winning: true)],
                adapter: _adapter);
        }

        internal void MarkUnreadable(string formKey)
        {
            _adapter.Unreadable = formKey;
            PluginBinaries.Touch(_path);
            Index.NextSnapshot();
        }

        public void Dispose()
        {
            Index.Dispose();
            _dataFolder.Dispose();
        }
    }
}
