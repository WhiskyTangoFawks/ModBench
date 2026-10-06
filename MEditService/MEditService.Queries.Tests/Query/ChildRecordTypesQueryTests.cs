using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Queries.Tests.Query;

public sealed class ChildRecordTypesQueryTests
{
    private const string PluginName = "Holds.esp";
    private const string Worldspace = "000801:Holds.esp";
    private static readonly PluginAddress Plugin = new(PluginName, "Data");

    private readonly FakeReads _reads;
    private readonly RecordQueryService _svc;
    private readonly FormKey _quest;
    private readonly FormKey _cell;

    public ChildRecordTypesQueryTests()
    {
        FormKey quest = default, cell = default;
        var fixture = new FakeFixtureBuilder()
            .WithPlugin(PluginName, mod =>
            {
                quest = mod.Quests.AddNew("Quest").FormKey;
                var held = new Cell(mod) { EditorID = "Cell" };
                var subBlock = new CellSubBlock { GroupType = GroupTypeEnum.InteriorCellSubBlock };
                subBlock.Cells.Add(held);
                var block = new CellBlock { GroupType = GroupTypeEnum.InteriorCellBlock };
                block.SubBlocks.Add(subBlock);
                mod.Cells.Records.Add(block);
                cell = held.FormKey;
            })
            .Build();
        var (index, holder) = FakeIndex.From(fixture);
        _reads = (FakeReads)index.RequireReads();
        _svc = new RecordQueryService(index, holder, SharedSchemaReflector.Instance);
        _quest = quest;
        _cell = cell;
    }

    [Fact]
    public void AQuest_HoldsTopicsBranchesAndScenes_NamedAsXEditNamesThem_InNameOrder()
    {
        var types = _svc.GetChildRecordTypes(Plugin, _quest.ToString());

        Assert.Equal<RecordTypeChoice>(
            [new("dlbr", "Dialog Branch"), new("dial", "Dialog Topic"), new("scen", "Scene")],
            types);
    }

    [Theory]
    [InlineData(null, null, true, new[] { "Navmesh" })]
    [InlineData(Worldspace, 0, false, new[] { "Landscape", "Navmesh" })]
    [InlineData(Worldspace, null, false, new string[0])]
    public void ACell_HoldsWhatItsPlaceInTheIndexAllows(string? worldspace, int? blockX, bool isInterior, string[] besidesPlacedRecords)
    {
        _reads.CellLocations = new Dictionary<RecordAt, CellLocationRow>
        {
            [new(Plugin, _cell.ToString())] = new(_cell.ToString(), worldspace, blockX, blockX, blockX, blockX, blockX, blockX, isInterior),
        };

        var types = _svc.GetChildRecordTypes(Plugin, _cell.ToString());

        Assert.Equal([.. besidesPlacedRecords, .. PlacedRecords], types?.Select(t => t.DisplayName));
    }

    private static readonly string[] PlacedRecords =
    [
        "Placed Arrow", "Placed Barrier", "Placed Beam", "Placed Cone/Voice", "Placed Flame", "Placed Hazard",
        "Placed Missile", "Placed NPC", "Placed Object", "Placed Projectile",
    ];

    [Fact]
    public void ACell_TakesItsPlaceFromThePluginAsked_NotAnotherOfTheSameName()
    {
        _reads.CellLocations = new Dictionary<RecordAt, CellLocationRow>
        {
            [new(Plugin, _cell.ToString())] = new(_cell.ToString(), Worldspace, 0, 0, 0, 0, 0, 0, IsInterior: false),
            [new(new PluginAddress(PluginName, "OtherMod"), _cell.ToString())] =
                new(_cell.ToString(), Worldspace, null, null, null, null, null, null, IsInterior: false),
        };

        var types = _svc.GetChildRecordTypes(Plugin, _cell.ToString());

        Assert.Contains("Landscape", types?.Select(t => t.DisplayName) ?? []);
    }

    [Fact]
    public void ARecordThePluginDoesNotHold_HasNoAnswer()
    {
        Assert.Null(_svc.GetChildRecordTypes(new PluginAddress("Other.esp", "Data"), _quest.ToString()));
    }
}
