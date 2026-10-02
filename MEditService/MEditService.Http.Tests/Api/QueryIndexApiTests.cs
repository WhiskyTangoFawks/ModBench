using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using static MEditService.Http.Tests.Api.QueriedPluginsFixture;

namespace MEditService.Http.Tests.Api;

/// <summary>query-index's questions that change nothing, asked of one host that loaded
/// <see cref="QueriedPluginsFixture"/> once.</summary>
public sealed class QueryIndexApiTests(LoadedApiFixture<QueriedPluginsFixture> loaded)
    : IClassFixture<LoadedApiFixture<QueriedPluginsFixture>>
{
    private HttpClient Client => loaded.Client;

    private async Task<JsonElement> InteriorBlocks() =>
        await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/interior-cells?origin={ListedMod}");

    private async Task<JsonElement> ExteriorSubBlockCells()
    {
        var worldspaces = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/worldspaces?origin={ListedMod}");
        var worldFk = Uri.EscapeDataString(worldspaces[0].GetProperty("formKey").GetString().Require());
        var blocks = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/worldspaces/{worldFk}/blocks?origin={ListedMod}");
        return blocks.GetProperty("blocks")[0].GetProperty("subBlocks")[0].GetProperty("cells");
    }

    [Fact]
    public async Task AQuestionAboutAPluginsRecords_IsAnsweredWithTheRowsAndThenTheRecord()
    {
        var page = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&origin={UserMod}&type=npc_&limit=10");

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
    public async Task AQuestionAboutOnePluginsRecordTypes_NamesEveryTypeInNameOrder()
    {
        var types = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/record-types?origin={UserMod}");

        Assert.Equal(
            ["Activator", "Cell", "Keyword", "Non-Player Character", "Quest", "Worldspace"],
            types.EnumerateArray().Select(t => t.GetProperty("displayName").GetString()));
    }

    [Fact]
    public async Task AGroupsRecords_CarryTheirNameWhenTheyHaveOne()
    {
        var activators = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&origin={UserMod}&type=acti&limit=10");
        var keywords = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&origin={UserMod}&type=kywd&limit=10");

        Assert.Equal("Lever", activators.GetProperty("items")[0].GetProperty("fullName").GetString());
        Assert.Equal(JsonValueKind.Null, keywords.GetProperty("items")[0].GetProperty("fullName").ValueKind);
    }

    [Fact]
    public async Task AContainersChildren_CarryTheirName()
    {
        var quests = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&origin={UserMod}&type=qust&limit=10");
        var questFk = Uri.EscapeDataString(quests.GetProperty("items")[0].GetProperty("formKey").GetString().Require());

        var children = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/records/{questFk}/children?origin={UserMod}");

        Assert.Equal("Greeting", children[0].GetProperty("fullName").GetString());
    }

    [Fact]
    public async Task AWorldspaceAndItsCells_CarryTheirNames()
    {
        var worldspaces = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/worldspaces?origin={UserMod}");
        var interiors = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/interior-cells?origin={UserMod}");

        var worldFk = Uri.EscapeDataString(worldspaces[0].GetProperty("formKey").GetString().Require());
        var blocks = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/worldspaces/{worldFk}/blocks?origin={UserMod}");

        Assert.Equal("Queried World", worldspaces[0].GetProperty("fullName").GetString());
        Assert.Equal(
            "Queried Clearing",
            blocks.GetProperty("blocks")[0].GetProperty("subBlocks")[0].GetProperty("cells")[0].GetProperty("fullName").GetString());
        Assert.Equal("Queried Room", interiors[0].GetProperty("subBlocks")[0].GetProperty("cells")[0].GetProperty("fullName").GetString());
    }

    [Fact]
    public async Task ACellsPlacedReferences_CarryTheirBaseRecordsEditorId()
    {
        var worldspaces = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/worldspaces?origin={UserMod}");
        var worldFk = Uri.EscapeDataString(worldspaces[0].GetProperty("formKey").GetString().Require());
        var blocks = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/worldspaces/{worldFk}/blocks?origin={UserMod}");
        var cellFk = Uri.EscapeDataString(
            blocks.GetProperty("blocks")[0].GetProperty("subBlocks")[0].GetProperty("cells")[0].GetProperty("formKey").GetString().Require());

        var references = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/cells/{cellFk}/children?origin={UserMod}");

        var placed = references.GetProperty("temporary")[0];
        Assert.Equal(JsonValueKind.Null, placed.GetProperty("editorId").ValueKind);
        Assert.Equal("QueriedLever", placed.GetProperty("baseEditorId").GetString());
    }

    [Fact]
    public async Task ARecordItsQuestHolds_IsListedOnlyBeneathItsQuest()
    {
        var types = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/record-types?origin={UserMod}");
        var quests = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&origin={UserMod}&type=qust&limit=10");
        var questFk = Uri.EscapeDataString(quests.GetProperty("items")[0].GetProperty("formKey").GetString().Require());

        var children = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/records/{questFk}/children?origin={UserMod}");

        Assert.DoesNotContain("dial", types.EnumerateArray().Select(t => t.GetProperty("type").GetString()));
        Assert.Equal(["QueriedTopic"], EditorIds(children));
    }

    [Fact]
    public async Task TheCellGroup_CountsTheInteriorCellsItLists()
    {
        var types = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/record-types?origin={UserMod}");
        var blocks = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/interior-cells?origin={UserMod}");

        var cellGroup = types.EnumerateArray().Single(t => t.GetProperty("type").GetString() == "cell");
        var listed = blocks.EnumerateArray()
            .SelectMany(b => b.GetProperty("subBlocks").EnumerateArray())
            .Sum(s => s.GetProperty("cells").GetArrayLength());
        Assert.Equal(listed, cellGroup.GetProperty("count").GetInt32());
    }

    [Fact]
    public async Task AGroupsListing_HoldsAsManyRecordsAsItsCount()
    {
        var types = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/record-types?origin={UserMod}");
        var cells = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&origin={UserMod}&type=cell&limit=10");

        var count = types.EnumerateArray().Single(t => t.GetProperty("type").GetString() == "cell").GetProperty("count").GetInt32();
        Assert.Equal(count, cells.GetProperty("total").GetInt32());
        Assert.Equal(count, cells.GetProperty("items").GetArrayLength());
    }

    [Fact]
    public async Task AQuestionAboutARecordNoPluginHolds_IsAnsweredWithNothingFound()
    {
        var response = await Client.GetAsync(new Uri("/records/000FFF:Nowhere.esp", UriKind.Relative));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task APluginsInteriorCells_AnswerAsTheBlocksAndSubBlocksTheFileHoldsThemIn()
    {
        var blocks = await InteriorBlocks();

        Assert.Equal([0, 3], blocks.EnumerateArray().Select(b => b.GetProperty("number").GetInt32()));
        var subBlocks = blocks[1].GetProperty("subBlocks");
        Assert.Equal([7], subBlocks.EnumerateArray().Select(s => s.GetProperty("number").GetInt32()));
        Assert.Equal(["ZuluRoom", "AlphaRoom"], EditorIds(subBlocks[0].GetProperty("cells")));
    }

    [Fact]
    public async Task APluginsWorldspaces_ListInFormIdOrder()
    {
        var worldspaces = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/worldspaces?origin={ListedMod}");

        Assert.Equal(["ZuluWorld", "AlphaWorld"], EditorIds(worldspaces));
    }

    [Fact]
    public async Task ASubBlocksCells_ListInFormIdOrder()
    {
        Assert.Equal(["ZuluClearing", "AlphaClearing"], EditorIds(await ExteriorSubBlockCells()));
    }

    [Fact]
    public async Task ACellsPlacedReferences_ListInFormIdOrder()
    {
        var room = (await InteriorBlocks())[1].GetProperty("subBlocks")[0].GetProperty("cells")[0];
        var roomFk = Uri.EscapeDataString(room.GetProperty("formKey").GetString().Require());

        var references = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/cells/{roomFk}/children?origin={ListedMod}");

        Assert.Equal(["ZuluRef", "AlphaRef"], EditorIds(references.GetProperty("temporary")));
    }

    [Fact]
    public async Task AQuestsChildren_ListInFormIdOrder_WhateverTheirType()
    {
        var quests = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={ListedPlugin}&origin={ListedMod}&type=qust&limit=10");
        var questFk = Uri.EscapeDataString(quests.GetProperty("items")[0].GetProperty("formKey").GetString().Require());

        var children = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/records/{questFk}/children?origin={ListedMod}");

        Assert.Equal(["ZuluScene", "AlphaTopic"], EditorIds(children));
    }

    [Fact]
    public async Task AWorldspace_SaysWhetherAnythingIsBeneathIt()
    {
        var worldspaces = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/worldspaces?origin={ListedMod}");

        Assert.Equal([true, false], worldspaces.EnumerateArray().Select(w => w.GetProperty("hasChildren").GetBoolean()));
    }

    [Fact]
    public async Task AnExteriorCell_SaysWhetherItHoldsAPlacedReference()
    {
        var clearings = await ExteriorSubBlockCells();

        Assert.Equal([true, false], clearings.EnumerateArray().Select(c => c.GetProperty("hasChildren").GetBoolean()));
    }

    [Theory]
    [InlineData("refr")]
    [InlineData("achr")]
    [InlineData("dial")]
    [InlineData("info")]
    [InlineData("dlbr")]
    [InlineData("scen")]
    public async Task ARecordAnotherRecordHolds_HasNoGroupOfItsOwn(string type)
    {
        var types = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{HeldPlugin}/record-types?origin={HeldMod}");
        var group = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={HeldPlugin}&origin={HeldMod}&type={type}&limit=10");
        var held = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={HeldPlugin}&origin={HeldMod}&type={type}&search=Held&limit=10");

        Assert.Equal(1, held.GetProperty("total").GetInt32());
        Assert.Equal(0, group.GetProperty("total").GetInt32());
        Assert.DoesNotContain(type, types.EnumerateArray().Select(t => t.GetProperty("type").GetString()));
    }
}
