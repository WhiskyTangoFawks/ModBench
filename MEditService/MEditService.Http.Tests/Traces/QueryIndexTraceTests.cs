using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Noggog;

namespace MEditService.Http.Tests.Traces;

/// <summary>query-index: a question and its answer are two arrows, and the Store is all the Queries
/// read, so every answer here is one the client asked for and got back.</summary>
[Collection(WebHostCollection.Name)]
public sealed class QueryIndexTraceTests : HostedTests
{
    private const string UserPlugin = "UserMod.esp";
    private const string ImmutablePlugin = "Fallout4.esm";
    private const string UserMod = "UserModFolder";

    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("trace-query")
        .WithPlugin(ImmutablePlugin, listed: false)
        .WithPlugin(UserPlugin, mod =>
        {
            mod.Npcs.AddNew("QueriedNpc").HeightMax = 0.5f;
            mod.Keywords.AddNew("QueriedKeyword");
            var lever = mod.Activators.AddNew("QueriedLever");
            lever.Name = "Lever";

            var quest = new Quest(mod) { EditorID = "QueriedQuest" };
            quest.DialogTopics.Add(new DialogTopic(mod) { EditorID = "QueriedTopic", Name = "Greeting" });
            mod.Quests.Add(quest);

            var world = mod.Worldspaces.AddNew("QueriedWorld");
            world.Name = "Queried World";
            var exterior = new Cell(mod) { Grid = new CellGrid { Point = new P2Int(3, -2) } };
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
        }, origin: UserMod)
        .BuildScattered();

    protected override void DisposeFixtures() => _instance.Dispose();

    private async Task Loaded() => (await Client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();

    [Fact]
    public async Task AQuestionAboutAPluginsRecords_IsAnsweredWithTheRowsAndThenTheRecord()
    {
        await Loaded();
        var page = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&type=npc_&limit=10");

        Assert.Equal(1, page.GetProperty("total").GetInt32());
        var summary = page.GetProperty("items")[0];
        Assert.Equal("QueriedNpc", summary.GetProperty("editorId").GetString());

        var detail = await Client.Record(summary.GetProperty("formKey").GetString().Require());
        Assert.Equal("QueriedNpc", detail.GetProperty("editorId").GetString());
        var height = detail.GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == "HeightMax");
        Assert.Equal(0.5, height.GetProperty("value").GetDouble(), 3);
    }

    [Fact]
    public async Task AQuestionAboutThePlugins_NamesTheOneNoEditCanTouch()
    {
        await Loaded();
        var plugins = await Client.Plugins();

        Assert.True((await Client.Plugin(ImmutablePlugin)).GetProperty("isImmutable").GetBoolean());
        Assert.False((await Client.Plugin(UserPlugin)).GetProperty("isImmutable").GetBoolean());
        Assert.Equal(2, plugins.Count);
    }

    [Fact]
    public async Task AQuestionAboutOnePluginsRecordTypes_CountsWhatItHolds()
    {
        await Loaded();
        var types = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/record-types");

        var counts = types.EnumerateArray().ToDictionary(
            t => t.GetProperty("type").GetString().Require(), t => t.GetProperty("count").GetInt32());
        Assert.Equal(1, counts["npc_"]);
        Assert.Equal(1, counts["kywd"]);
    }

    [Fact]
    public async Task AQuestionAboutOnePluginsRecordTypes_NamesEveryTypeInNameOrder()
    {
        await Loaded();
        var types = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/record-types");

        Assert.Equal(
            ["Activator", "Cell", "Dialog Topic", "Keyword", "Non-Player Character", "Placed Object", "Quest", "Worldspace"],
            types.EnumerateArray().Select(t => t.GetProperty("displayName").GetString()));
    }

    [Fact]
    public async Task AGroupsRecords_CarryTheirNameWhenTheyHaveOne()
    {
        await Loaded();
        var activators = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&type=acti&limit=10");
        var keywords = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&type=kywd&limit=10");

        Assert.Equal("Lever", activators.GetProperty("items")[0].GetProperty("fullName").GetString());
        Assert.Equal(JsonValueKind.Null, keywords.GetProperty("items")[0].GetProperty("fullName").ValueKind);
    }

    [Fact]
    public async Task AContainersChildren_CarryTheirName()
    {
        await Loaded();
        var quests = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&type=qust&limit=10");
        var questFk = Uri.EscapeDataString(quests.GetProperty("items")[0].GetProperty("formKey").GetString().Require());

        var children = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/records/{questFk}/children");

        Assert.Equal("Greeting", children[0].GetProperty("fullName").GetString());
    }

    [Fact]
    public async Task AWorldspaceAndItsCells_CarryTheirNames()
    {
        await Loaded();
        var worldspaces = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/worldspaces");
        var interiors = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/interior-cells?limit=50&offset=0");

        Assert.Equal("Queried World", worldspaces[0].GetProperty("fullName").GetString());
        Assert.Equal("Queried Room", interiors.GetProperty("items")[0].GetProperty("fullName").GetString());
    }

    [Fact]
    public async Task ACellsPlacedReferences_CarryTheirBaseRecordsEditorId()
    {
        await Loaded();
        var worldspaces = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/worldspaces");
        var worldFk = Uri.EscapeDataString(worldspaces[0].GetProperty("formKey").GetString().Require());
        var blocks = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/worldspaces/{worldFk}/blocks");
        var cellFk = Uri.EscapeDataString(
            blocks.GetProperty("blocks")[0].GetProperty("subBlocks")[0].GetProperty("cells")[0].GetProperty("formKey").GetString().Require());

        var references = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/cells/{cellFk}/references");

        var placed = references.GetProperty("temporary")[0];
        Assert.Equal(JsonValueKind.Null, placed.GetProperty("editorId").ValueKind);
        Assert.Equal("QueriedLever", placed.GetProperty("baseEditorId").GetString());
    }

    [Fact]
    public async Task AQuestionAboutARecordNoPluginHolds_IsAnsweredWithNothingFound()
    {
        await Loaded();
        var response = await Client.GetAsync(new Uri("/records/000FFF:Nowhere.esp", UriKind.Relative));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
