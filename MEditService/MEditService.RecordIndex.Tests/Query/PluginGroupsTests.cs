using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Noggog;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class PluginGroupsTests(PluginGroupsTests.TwoPlugins shared) : IClassFixture<PluginGroupsTests.TwoPlugins>
{
    private static readonly PluginAddress OneOfEveryKind = new("OneOfEveryKind.esp", "OneOfEveryKindMod");
    private static readonly PluginAddress HeldByAnotherRecord = new("Held.esp", "HeldMod");

    public sealed class TwoPlugins : IDisposable
    {
        private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("plugin-groups")
            .WithPlugin(OneOfEveryKind.Name, mod =>
            {
                mod.Npcs.AddNew("GroupNpc");
                mod.Armors.AddNew("GroupArmor");
                mod.ArmorAddons.AddNew("GroupArmorAddon");
                mod.Keywords.AddNew("GroupKeyword");
                mod.Activators.AddNew("GroupLever");

                var quest = new Quest(mod) { EditorID = "GroupQuest" };
                var topic = new DialogTopic(mod) { EditorID = "GroupTopic", Name = "Greeting" };
                quest.DialogTopics.Add(topic);
                mod.Quests.Add(quest);

                var world = mod.Worldspaces.AddNew("GroupWorld");
                world.Name = "Group World";
                var exterior = new Cell(mod) { Name = "Group Clearing", Grid = new CellGrid { Point = new P2Int(3, -2) } };
                var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = -1 };
                subBlock.Items.Add(exterior);
                var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = -1 };
                block.Items.Add(subBlock);
                world.SubCells.Add(block);

                mod.AddInteriorCells(new Cell(mod) { EditorID = "GroupRoom", Name = "Group Room" });
            }, origin: OneOfEveryKind.Origin)
            .WithPlugin(HeldByAnotherRecord.Name, mod =>
            {
                var topic = new DialogTopic(mod) { EditorID = "HeldTopic" };
                topic.Responses.Add(new DialogResponses(mod) { EditorID = "HeldResponse" });
                var quest = new Quest(mod) { EditorID = "HeldQuest" };
                quest.DialogTopics.Add(topic);
                quest.DialogBranches.Add(new DialogBranch(mod) { EditorID = "HeldBranch" });
                quest.Scenes.Add(new Scene(mod) { EditorID = "HeldScene" });
                mod.Quests.Add(quest);

                var room = new Cell(mod) { EditorID = "HeldRoom" };
                room.Temporary.Add(new PlacedObject(mod) { EditorID = "HeldRef" });
                room.Persistent.Add(new PlacedNpc(mod) { EditorID = "HeldActor" });
                mod.AddInteriorCells(room);
            }, origin: HeldByAnotherRecord.Origin)
            .BuildScattered();

        internal OpenedIndex Index { get; }

        public TwoPlugins() => Index = Indexes.Reconciled(_fixture);

        public void Dispose()
        {
            Index.Dispose();
            _fixture.Dispose();
        }
    }

    private readonly IQueries _queries = shared.Index.Queries;

    [Fact]
    public void APluginsRecordTypes_AreInTheOrderOfTheirNames()
    {
        var names = _queries.GetPluginRecordTypes(OneOfEveryKind).Value().Select(t => t.DisplayName);

        Assert.Equal(["Activator", "Armor", "Armor Addon", "Cell", "Keyword", "Non-Player Character", "Quest", "Worldspace"], names);
    }

    [Fact]
    public void TheCellGroup_CountsTheInteriorCellsItLists_AndTheCellsItsListingHolds()
    {
        var group = Assert.Single(_queries.GetPluginRecordTypes(OneOfEveryKind).Value(), t => t.Type == "cell");
        var interiors = _queries.GetInteriorCells(OneOfEveryKind).Value().SelectMany(b => b.SubBlocks).Sum(s => s.Cells.Count);
        var listed = _queries.GetRecords(["cell"], OneOfEveryKind, search: null, limit: 10, offset: 0).Value();

        Assert.Equal((1, 1, 1), (group.Count, interiors, listed.Total));
        Assert.Equal(group.Count, listed.Items.Count);
    }

    [Fact]
    public void AContainersChildren_CarryTheirName()
    {
        var quest = _queries.GetRecords(["qust"], OneOfEveryKind, search: null, limit: 10, offset: 0).Value().Items.Single();

        var children = _queries.GetContainerChildren(OneOfEveryKind, quest.FormKey).Value();

        Assert.Equal("Greeting", Assert.Single(children).FullName);
    }

    [Fact]
    public void AWorldspace_CarriesItsName()
    {
        var worldspace = Assert.Single(_queries.GetWorldspaces(OneOfEveryKind).Value());

        Assert.Equal("Group World", worldspace.FullName);
    }

    [Fact]
    public void AnInteriorCell_CarriesItsName()
    {
        var interiors = _queries.GetInteriorCells(OneOfEveryKind).Value();

        Assert.Equal("Group Room", interiors[0].SubBlocks[0].Cells[0].FullName);
    }

    [Theory]
    [InlineData("refr")]
    [InlineData("achr")]
    [InlineData("dial")]
    [InlineData("info")]
    [InlineData("dlbr")]
    [InlineData("scen")]
    public void ARecordAnotherRecordHolds_HasNoGroupOfItsOwn_ButASearchFindsIt(string type)
    {
        var group = _queries.GetRecords([type], HeldByAnotherRecord, search: null, limit: 10, offset: 0).Value();
        var found = _queries.GetRecords([type], HeldByAnotherRecord, search: "Held", limit: 10, offset: 0).Value();

        Assert.Equal((0, 1), (group.Total, found.Total));
        Assert.DoesNotContain(_queries.GetPluginRecordTypes(HeldByAnotherRecord).Value(), t => t.Type == type);
    }
}
