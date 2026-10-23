using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class FilterHierarchyTests
{
    private static readonly PluginAddress Rooms = new("Rooms.esp", "RoomsMod");

    private static ScatteredFixtureData RoomsAndDialogue() =>
        new PluginFixtureBuilder("filter-hierarchy-rooms")
            .WithPlugin(Rooms.Name, mod =>
            {
                var zuluRoom = new Cell(mod) { EditorID = "ZuluRoom" };
                zuluRoom.Temporary.Add(new PlacedObject(mod) { EditorID = "ZuluRef" });
                zuluRoom.Temporary.Add(new PlacedObject(mod) { EditorID = "AlphaRef" });
                mod.AddInteriorCells(zuluRoom, new Cell(mod) { EditorID = "AlphaRoom" });

                var topic = new DialogTopic(mod) { EditorID = "RoomsTopic" };
                topic.Responses.Add(new DialogResponses(mod) { EditorID = "RoomsResponse" });
                var quest = new Quest(mod) { EditorID = "RoomsQuest" };
                quest.DialogTopics.Add(topic);
                mod.Quests.Add(quest);
            }, origin: Rooms.Origin)
            .BuildScattered();

    private static void Filter(OpenedIndex index, string editorId) =>
        index.SetFilter($"SELECT form_key FROM records WHERE editor_id = '{editorId}'", "held.sql");

    private static List<string?> RoomNames(OpenedIndex index, PluginAddress plugin) =>
        [.. index.Queries.GetInteriorCells(plugin).Value()
            .SelectMany(block => block.SubBlocks)
            .SelectMany(subBlock => subBlock.Cells)
            .Select(cell => cell.EditorId)];

    private static ScatteredFixtureData TwoPluginsHoldingTheRoomBase(Action<Fallout4Mod, Fallout4Mod> second, string secondName, string secondOrigin) =>
        new PluginFixtureBuilder("filter-hierarchy-holders")
            .WithPlugin("Base.esm", mod =>
            {
                var room = new Cell(mod) { EditorID = "BaseRoom" };
                room.Temporary.Add(new PlacedObject(mod) { EditorID = "BaseRef" });
                mod.AddInteriorCells(room);
            }, origin: "BaseMod")
            .WithPlugin(secondName, (mod, masters) => second(mod, masters[0]), origin: secondOrigin)
            .BuildScattered();

    [Fact]
    public void AFilterMatchingAPlacedReference_ListsTheCellHoldingIt_AndOnlyTheMatchBeneathIt()
    {
        using var fixture = RoomsAndDialogue();
        using var index = Indexes.Reconciled(fixture);

        Filter(index, "ZuluRef");

        Assert.Equal(["Cell"], index.Queries.GetPluginRecordTypes(Rooms).Value().Select(t => t.DisplayName));
        Assert.Equal(["ZuluRoom"], RoomNames(index, Rooms));
        var room = index.Queries.GetInteriorCells(Rooms).Value()[0].SubBlocks[0].Cells[0];
        Assert.Equal(["ZuluRef"], index.Queries.GetCellChildRecords(Rooms, room.FormKey).Value().Temporary.Select(r => r.EditorId));
    }

    [Fact]
    public void AFilterMatchingAResponse_ListsTheQuestAndTopicAboveIt()
    {
        using var fixture = RoomsAndDialogue();
        using var index = Indexes.Reconciled(fixture);

        Filter(index, "RoomsResponse");

        Assert.Equal(["Quest"], index.Queries.GetPluginRecordTypes(Rooms).Value().Select(t => t.DisplayName));
        var quest = index.Queries.GetRecords(["qust"], Rooms, search: null, limit: 10, offset: 0).Value().Items.Single();
        Assert.Equal(["RoomsTopic"], index.Queries.GetContainerChildren(Rooms, quest.FormKey).Value().Select(c => c.EditorId));
    }

    [Fact]
    public void AFilter_KeepsOnlyThePluginsHoldingAMatch_NotThoseHoldingOnlyItsHolders()
    {
        using var fixture = TwoPluginsHoldingTheRoomBase((mod, baseMod) =>
        {
            var room = baseMod.Cells.Records[0].SubBlocks[0].Cells[0].DeepCopy();
            room.Temporary.Clear();
            room.Temporary.Add(new PlacedObject(mod) { EditorID = "DressingRef" });
            mod.AddInteriorCells(room);
        }, "Dressing.esp", "DressingMod");
        using var index = Indexes.Reconciled(fixture);

        Filter(index, "DressingRef");

        Assert.Equal(
            ["Dressing.esp"],
            index.Queries.GetPlugins().Value().Where(p => p.HasMatchingRecords).Select(p => p.Name));
    }

    [Fact]
    public void AFilter_ListsAHolderOnlyInThePluginWhoseCopyHoldsTheMatch()
    {
        using var fixture = TwoPluginsHoldingTheRoomBase((mod, baseMod) =>
        {
            var room = baseMod.Cells.Records[0].SubBlocks[0].Cells[0].DeepCopy();
            room.Temporary.Clear();
            room.WaterHeight = 10f;
            mod.AddInteriorCells(room);
        }, "Lighting.esp", "LightingMod");
        using var index = Indexes.Reconciled(fixture);

        Filter(index, "BaseRef");

        Assert.Equal(["BaseRoom"], RoomNames(index, new PluginAddress("Base.esm", "BaseMod")));
        Assert.Empty(RoomNames(index, new PluginAddress("Lighting.esp", "LightingMod")));
    }
}
