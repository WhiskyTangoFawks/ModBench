using System.Text.Json;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Noggog;

namespace MEditService.Http.Tests.Api;

/// <summary>Three plugins in three mods, each built for one family of questions: one of every kind
/// of record, records whose order is not their editor IDs' order, and records another record
/// holds.</summary>
public sealed class QueriedPluginsFixture : IApiPluginFixture<QueriedPluginsFixture>
{
    public const string UserPlugin = "UserMod.esp";
    public const string UserMod = "UserModFolder";
    public const string ListedPlugin = "Listed.esp";
    public const string ListedMod = "ListedMod";
    public const string HeldPlugin = "Held.esp";
    public const string HeldMod = "HeldMod";

    public ScatteredFixtureData Data { get; } = new PluginFixtureBuilder("query-index")
        .WithPlugin(UserPlugin, OneOfEveryKind, origin: UserMod)
        .WithPlugin(ListedPlugin, OutOfEditorIdOrder, origin: ListedMod)
        .WithPlugin(HeldPlugin, HeldByAnotherRecord, origin: HeldMod)
        .BuildScattered();

    public string DataFolder => Data.GameDirectory;
    public IReadOnlyList<LoadOrderEntry> Plugins => Data.Plugins;
    public string InstanceRoot => Data.InstanceRoot;

    public static QueriedPluginsFixture Create() => new();

    public void Dispose() => Data.Dispose();

    public static IEnumerable<string?> EditorIds(JsonElement rows) =>
        rows.EnumerateArray().Select(r => r.GetProperty("editorId").GetString());

    private static void OneOfEveryKind(Fallout4Mod mod)
    {
        mod.Npcs.AddNew("QueriedNpc").HeightMax = 0.5f;
        mod.Keywords.AddNew("QueriedKeyword");
        var lever = mod.Activators.AddNew("QueriedLever");
        lever.Name = "Lever";

        var quest = new Quest(mod) { EditorID = "QueriedQuest" };
        var topic = new DialogTopic(mod) { EditorID = "QueriedTopic", Name = "Greeting" };
        topic.Responses.Add(new DialogResponses(mod) { EditorID = "QueriedResponse" });
        quest.DialogTopics.Add(topic);
        mod.Quests.Add(quest);

        var world = mod.Worldspaces.AddNew("QueriedWorld");
        world.Name = "Queried World";
        var exterior = new Cell(mod) { Name = "Queried Clearing", Grid = new CellGrid { Point = new P2Int(3, -2) } };
        var unnamedRef = new PlacedObject(mod);
        unnamedRef.Base.SetTo(lever);
        exterior.Temporary.Add(unnamedRef);
        var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = -1 };
        subBlock.Items.Add(exterior);
        var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = -1 };
        block.Items.Add(subBlock);
        world.SubCells.Add(block);

        var interior = new Cell(mod) { EditorID = "QueriedRoom", Name = "Queried Room" };
        var interiorSubBlock = new CellSubBlock { BlockNumber = 0 };
        interiorSubBlock.Cells.Add(interior);
        var interiorBlock = new CellBlock { BlockNumber = 0 };
        interiorBlock.SubBlocks.Add(interiorSubBlock);
        mod.Cells.Records.Add(interiorBlock);
    }

    private static void OutOfEditorIdOrder(Fallout4Mod mod)
    {
        mod.Activators.AddNew("ZuluLever");
        mod.Activators.AddNew("AlphaLever");

        var quest = new Quest(mod) { EditorID = "ListedQuest" };
        quest.Scenes.Add(new Scene(mod) { EditorID = "ZuluScene" });
        quest.DialogTopics.Add(new DialogTopic(mod) { EditorID = "AlphaTopic" });
        mod.Quests.Add(quest);

        var zuluWorld = mod.Worldspaces.AddNew("ZuluWorld");
        mod.Worldspaces.AddNew("AlphaWorld");
        var zuluClearing = new Cell(mod) { EditorID = "ZuluClearing", Grid = new CellGrid { Point = new P2Int(1, 1) } };
        zuluClearing.Temporary.Add(new PlacedObject(mod) { EditorID = "ClearingRef" });
        var alphaClearing = new Cell(mod) { EditorID = "AlphaClearing", Grid = new CellGrid { Point = new P2Int(0, 0) } };
        var exteriorSubBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
        exteriorSubBlock.Items.Add(zuluClearing);
        exteriorSubBlock.Items.Add(alphaClearing);
        var exteriorBlock = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
        exteriorBlock.Items.Add(exteriorSubBlock);
        zuluWorld.SubCells.Add(exteriorBlock);

        var zuluRoom = new Cell(mod) { EditorID = "ZuluRoom" };
        zuluRoom.Temporary.Add(new PlacedObject(mod) { EditorID = "ZuluRef" });
        zuluRoom.Temporary.Add(new PlacedObject(mod) { EditorID = "AlphaRef" });
        var alphaRoom = new Cell(mod) { EditorID = "AlphaRoom" };
        var roomSubBlock = new CellSubBlock { BlockNumber = 7 };
        roomSubBlock.Cells.Add(zuluRoom);
        roomSubBlock.Cells.Add(alphaRoom);
        var roomBlock = new CellBlock { BlockNumber = 3 };
        roomBlock.SubBlocks.Add(roomSubBlock);

        var otherSubBlock = new CellSubBlock { BlockNumber = 0 };
        otherSubBlock.Cells.Add(new Cell(mod) { EditorID = "OtherRoom" });
        var otherBlock = new CellBlock { BlockNumber = 0 };
        otherBlock.SubBlocks.Add(otherSubBlock);

        mod.Cells.Records.Add(roomBlock);
        mod.Cells.Records.Add(otherBlock);
    }

    private static void HeldByAnotherRecord(Fallout4Mod mod)
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
        var subBlock = new CellSubBlock { BlockNumber = 0 };
        subBlock.Cells.Add(room);
        var block = new CellBlock { BlockNumber = 0 };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    }
}
