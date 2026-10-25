using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class ChildRecordTypesQueryTests : IDisposable
{
    private const string PluginName = "Holds.esp";
    private const string Quest = "000800:Holds.esp";
    private const string InteriorCell = "000801:Holds.esp";
    private const string ExteriorCell = "000803:Holds.esp";
    private const string TopCell = "000805:Holds.esp";
    private const string ExteriorCellWithLandscape = "000808:Holds.esp";
    private static readonly PluginAddress Plugin = new(PluginName, PluginOrigin.DataDirectory);

    private readonly ScatteredFixtureData _fixture;
    private readonly OpenedIndex _index;

    public ChildRecordTypesQueryTests()
    {
        _fixture = new PluginFixtureBuilder("child-record-types")
            .WithPlugin(PluginName, mod => mod.Worldspaces.Add(Worldspace(0x802, topCell: Cell(ExteriorCell))), origin: "OtherMod")
            .WithPlugin(PluginName, mod =>
            {
                mod.Quests.Add(new Quest(FormKey.Factory(Quest), Fallout4Release.Fallout4));

                var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
                subBlock.Cells.Add(Cell(InteriorCell));
                var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
                block.SubBlocks.Add(subBlock);
                mod.Cells.Records.Add(block);

                var exterior = Cell(ExteriorCell);
                exterior.Grid = new CellGrid { Point = new P2Int(0, 0) };
                var landscaped = Cell(ExteriorCellWithLandscape);
                landscaped.Grid = new CellGrid { Point = new P2Int(1, 0) };
                landscaped.Landscape = new Landscape(new FormKey(ModKey.FromFileName(PluginName), 0x809), Fallout4Release.Fallout4);
                var worldSubBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                worldSubBlock.Items.Add(exterior);
                worldSubBlock.Items.Add(landscaped);
                var worldBlock = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                worldBlock.Items.Add(worldSubBlock);
                var world = Worldspace(0x802);
                world.SubCells.Add(worldBlock);
                mod.Worldspaces.Add(world);

                mod.Worldspaces.Add(Worldspace(0x804, topCell: Cell(TopCell)));
            })
            .BuildScattered();
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static Cell Cell(string formKey) => new(FormKey.Factory(formKey), Fallout4Release.Fallout4);

    private static Worldspace Worldspace(uint id, Cell? topCell = null) =>
        new(new FormKey(ModKey.FromFileName(PluginName), id), Fallout4Release.Fallout4) { TopCell = topCell };

    [Fact]
    public void AQuest_HoldsTopicsBranchesAndScenes_NamedAsXEditNamesThem_InNameOrder()
    {
        var types = _index.Queries.GetChildRecordTypes(Plugin, Quest).Value();

        Assert.Equal<RecordTypeChoice>(
            [new("dlbr", "Dialog Branch"), new("dial", "Dialog Topic"), new("scen", "Scene")],
            types);
    }

    [Theory]
    [InlineData(InteriorCell, new[] { "Navmesh" })]
    [InlineData(ExteriorCell, new[] { "Landscape", "Navmesh" })]
    [InlineData(TopCell, new[] { "Navmesh" })]
    [InlineData(ExteriorCellWithLandscape, new[] { "Navmesh" })]
    public void ACell_HoldsWhatItsPlaceInThePluginAskedAllows_NotInAnotherOfTheSameName(string cell, string[] besidesPlacedRecords)
    {
        var types = _index.Queries.GetChildRecordTypes(Plugin, cell).Value();

        Assert.Equal([.. besidesPlacedRecords, .. PlacedRecordTables.DisplayNames], types?.Select(t => t.DisplayName));
    }

    [Fact]
    public void ARecordThePluginDoesNotHold_HasNoAnswer()
    {
        Assert.Null(_index.Queries.GetChildRecordTypes(new PluginAddress("Other.esp", PluginOrigin.DataDirectory), Quest).Value());
    }
}
