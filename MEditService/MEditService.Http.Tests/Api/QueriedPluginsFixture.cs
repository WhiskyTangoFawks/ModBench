using System.Text.Json;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Noggog;

namespace MEditService.Http.Tests.Api;

/// <summary>One plugin in one mod, holding one of every kind of record the queries ask about.</summary>
public sealed class QueriedPluginsFixture : IApiPluginFixture<QueriedPluginsFixture>
{
    public const string UserPlugin = "UserMod.esp";
    public const string UserMod = "UserModFolder";

    public ScatteredFixtureData Data { get; } = new PluginFixtureBuilder("query-record-index")
        .WithPlugin(UserPlugin, OneOfEveryKind, origin: UserMod)
        .BuildScattered();

    public string DataFolder => Data.DataFolder;
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
}
