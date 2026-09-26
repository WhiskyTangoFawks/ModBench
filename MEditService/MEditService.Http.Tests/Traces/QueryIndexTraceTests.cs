using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;
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
            ["Activator", "Cell", "Keyword", "Non-Player Character", "Quest", "Worldspace"],
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

    private async Task LoadedLocalized()
    {
        var localized = Owned(new PluginFixtureBuilder("trace-query-localized")
            .WithPlugin("Localized.esp", mod =>
            {
                mod.UsingLocalization = true;
                mod.Activators.AddNew("LocalizedLever").Name = new TranslatedString(
                    Language.English,
                    new KeyValuePair<Language, string>(Language.French, "Levier"),
                    new KeyValuePair<Language, string>(Language.English, "Lever"));
            }, origin: "LocalizedMod")
            .BuildScattered());
        (await Client.PutLoadOrder(localized)).EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task ALocalizedPluginsRecords_CarryTheirNameInTheTargetLanguage()
    {
        await LoadedLocalized();

        var activators = await Client.GetFromJsonAsync<JsonElement>("/records?plugin=Localized.esp&type=acti&limit=10");

        Assert.Equal("Lever", activators.GetProperty("items")[0].GetProperty("fullName").GetString());
    }

    [Fact]
    public async Task ALocalizedName_ReadsTheSameThroughTheSqlDoor()
    {
        await LoadedLocalized();

        (await Client.PostAsJsonAsync("/load-order/filter",
            new { sql = "SELECT form_key FROM \"acti\" WHERE \"Name\" = 'Lever'", source = "lever.sql" })).EnsureSuccessStatusCode();
        var activators = await Client.GetFromJsonAsync<JsonElement>("/records?plugin=Localized.esp&type=acti&limit=10");

        Assert.Equal(1, activators.GetProperty("total").GetInt32());
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
        var interiors = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/interior-cells");

        var worldFk = Uri.EscapeDataString(worldspaces[0].GetProperty("formKey").GetString().Require());
        var blocks = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/worldspaces/{worldFk}/blocks");

        Assert.Equal("Queried World", worldspaces[0].GetProperty("fullName").GetString());
        Assert.Equal(
            "Queried Clearing",
            blocks.GetProperty("blocks")[0].GetProperty("subBlocks")[0].GetProperty("cells")[0].GetProperty("fullName").GetString());
        Assert.Equal("Queried Room", interiors[0].GetProperty("subBlocks")[0].GetProperty("cells")[0].GetProperty("fullName").GetString());
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

    private async Task<JsonElement> PlacedReferencesIn(string plugin)
    {
        var interiors = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{plugin}/interior-cells");
        var cellFk = Uri.EscapeDataString(
            interiors[0].GetProperty("subBlocks")[0].GetProperty("cells")[0].GetProperty("formKey").GetString().Require());
        var references = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{plugin}/cells/{cellFk}/references");
        return references.GetProperty("temporary")[0];
    }

    private static void PlaceInARoom(Fallout4Mod mod, IFormLinkGetter<IPlaceableObjectGetter> baseRecord)
    {
        var placed = new PlacedObject(mod);
        placed.Base.SetTo(baseRecord);
        var room = new Cell(mod) { EditorID = $"{mod.ModKey.Name}Room" };
        room.Temporary.Add(placed);
        var subBlock = new CellSubBlock { BlockNumber = 0 };
        subBlock.Cells.Add(room);
        var block = new CellBlock { BlockNumber = 0 };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    }

    private async Task LoadedWithTwoCopiesOfABase()
    {
        var fixture = Owned(new PluginFixtureBuilder("trace-query-base-copies")
            .WithPlugin("Master.esm", mod =>
            {
                var lever = mod.Activators.AddNew("MasterLever");
                PlaceInARoom(mod, lever.ToLink());
            }, origin: "MasterMod")
            .WithPlugin("Patch.esp", (mod, masters) =>
                mod.Activators.GetOrAddAsOverride(masters[0].Activators.First()).EditorID = "PatchLever", origin: "PatchMod")
            .WithPlugin("Other.esp", (mod, masters) =>
                PlaceInARoom(mod, masters[0].Activators.First().ToLink()), origin: "OtherMod")
            .BuildScattered());
        (await Client.PutLoadOrder(fixture)).EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task APlacedReference_NamesItsBaseAsItsOwnPluginHoldsIt()
    {
        await LoadedWithTwoCopiesOfABase();

        var placed = await PlacedReferencesIn("Master.esm");

        Assert.Equal("MasterLever", placed.GetProperty("baseEditorId").GetString());
    }

    [Fact]
    public async Task APlacedReference_WhosePluginHoldsNoCopyOfItsBase_NamesItAsTheWinningCopyDoes()
    {
        await LoadedWithTwoCopiesOfABase();

        var placed = await PlacedReferencesIn("Other.esp");

        Assert.Equal("PatchLever", placed.GetProperty("baseEditorId").GetString());
    }

    private const string ListedPlugin = "Listed.esp";
    private const int FillerRooms = 60;

    private async Task LoadedListings()
    {
        var fixture = Owned(new PluginFixtureBuilder("trace-query-listings")
            .WithPlugin(ListedPlugin, mod =>
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

                var fillerSubBlock = new CellSubBlock { BlockNumber = 0 };
                for (var i = 0; i < FillerRooms; i++) fillerSubBlock.Cells.Add(new Cell(mod) { EditorID = $"FillerRoom{i:D2}" });
                var fillerBlock = new CellBlock { BlockNumber = 0 };
                fillerBlock.SubBlocks.Add(fillerSubBlock);

                mod.Cells.Records.Add(roomBlock);
                mod.Cells.Records.Add(fillerBlock);
            }, origin: "ListedMod")
            .BuildScattered());
        (await Client.PutLoadOrder(fixture)).EnsureSuccessStatusCode();
    }

    private static IEnumerable<string?> EditorIds(JsonElement rows) =>
        rows.EnumerateArray().Select(r => r.GetProperty("editorId").GetString());

    private async Task<JsonElement> InteriorBlocks() =>
        await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/interior-cells");

    private async Task<JsonElement> ExteriorSubBlockCells()
    {
        var worldspaces = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/worldspaces");
        var worldFk = Uri.EscapeDataString(worldspaces[0].GetProperty("formKey").GetString().Require());
        var blocks = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/worldspaces/{worldFk}/blocks");
        return blocks.GetProperty("blocks")[0].GetProperty("subBlocks")[0].GetProperty("cells");
    }

    [Fact]
    public async Task APluginsInteriorCells_AnswerAsTheBlocksAndSubBlocksTheFileHoldsThemIn()
    {
        await LoadedListings();

        var blocks = await InteriorBlocks();

        Assert.Equal([0, 3], blocks.EnumerateArray().Select(b => b.GetProperty("number").GetInt32()));
        var subBlocks = blocks[1].GetProperty("subBlocks");
        Assert.Equal([7], subBlocks.EnumerateArray().Select(s => s.GetProperty("number").GetInt32()));
        Assert.Equal(["ZuluRoom", "AlphaRoom"], EditorIds(subBlocks[0].GetProperty("cells")));
    }

    [Fact]
    public async Task APluginsInteriorCells_AnswerWholeInOneCall()
    {
        await LoadedListings();

        var blocks = await InteriorBlocks();

        var cells = blocks.EnumerateArray()
            .SelectMany(b => b.GetProperty("subBlocks").EnumerateArray())
            .SelectMany(s => s.GetProperty("cells").EnumerateArray());
        Assert.Equal(FillerRooms + 2, cells.Count());
    }

    [Fact]
    public async Task AGroupsRecords_ListInFormIdOrder()
    {
        await LoadedListings();

        var activators = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={ListedPlugin}&type=acti&limit=10");

        Assert.Equal(["ZuluLever", "AlphaLever"], EditorIds(activators.GetProperty("items")));
    }

    [Fact]
    public async Task AGroupsRecords_ListAMastersRecordsBeforeThePluginsOwn_AsTheirLoadOrderFormIdsSort()
    {
        var fixture = Owned(new PluginFixtureBuilder("trace-query-master-order")
            .WithPlugin("Master.esm", mod =>
            {
                mod.Activators.AddNew("MasterFirst");
                mod.Activators.AddNew("MasterSecond");
            }, origin: "MasterMod")
            .WithPlugin("Patch.esp", (mod, masters) =>
            {
                mod.Activators.AddNew("APatchLever");
                mod.Activators.GetOrAddAsOverride(masters[0].Activators.Last());
            }, origin: "PatchMod")
            .BuildScattered());
        (await Client.PutLoadOrder(fixture)).EnsureSuccessStatusCode();

        var activators = await Client.GetFromJsonAsync<JsonElement>("/records?plugin=Patch.esp&type=acti&limit=10");

        Assert.Equal(["MasterSecond", "APatchLever"], EditorIds(activators.GetProperty("items")));
    }

    [Fact]
    public async Task AGroupsRecords_ListALightMastersRecordsAfterAFullMastersLoadedAfterIt()
    {
        var fixture = Owned(new PluginFixtureBuilder("trace-query-light-order")
            .WithPlugin("Light.esl", mod => mod.Activators.AddNew("ALightLever"), origin: "LightMod")
            .WithPlugin("Full.esm", mod => mod.Activators.AddNew("ZFullLever"), origin: "FullMod")
            .WithPlugin("Patch.esp", (mod, masters) =>
            {
                mod.Activators.GetOrAddAsOverride(masters[0].Activators.Single());
                mod.Activators.GetOrAddAsOverride(masters[1].Activators.Single());
            }, origin: "PatchMod")
            .BuildScattered());
        (await Client.PutLoadOrder(fixture)).EnsureSuccessStatusCode();

        var activators = await Client.GetFromJsonAsync<JsonElement>("/records?plugin=Patch.esp&type=acti&limit=10");

        Assert.Equal(["ZFullLever", "ALightLever"], EditorIds(activators.GetProperty("items")));
    }

    [Theory]
    [InlineData("FullTwin", "LightTwin", new[] { "ZTwinLever", "ALateLever" })]
    [InlineData("LightTwin", "FullTwin", new[] { "ALateLever", "ZTwinLever" })]
    public async Task AFilenamesFormIds_SortAsThePluginTheGameLoadsUnderIt_NotAnOverriddenCopy(
        string winnerOrigin, string loserOrigin, string[] expected)
    {
        var fixture = Owned(new PluginFixtureBuilder("trace-query-twin-order")
            .WithPlugin("Twin.esp", mod =>
            {
                mod.IsSmallMaster = true;
                mod.Activators.AddNew("ZTwinLever");
            }, origin: "LightTwin")
            .WithPlugin("Twin.esp", mod => mod.Activators.AddNew("ZTwinLever"), origin: "FullTwin")
            .WithPlugin("Late.esm", mod => mod.Activators.AddNew("ALateLever"), origin: "LateMod")
            .WithPlugin("Patch.esp", (mod, masters) =>
            {
                mod.Activators.GetOrAddAsOverride(masters[1].Activators.Single());
                mod.Activators.GetOrAddAsOverride(masters[2].Activators.Single());
            }, origin: "PatchMod")
            .BuildScattered());
        var winner = fixture.Plugins.Single(p => p.Origin == winnerOrigin);
        (await Client.PutLoadOrder(fixture, fixture.Plugins.Select(p => p.Origin == loserOrigin
            ? p with { Slot = winner.Slot, Winning = false }
            : p))).EnsureSuccessStatusCode();

        var activators = await Client.GetFromJsonAsync<JsonElement>("/records?plugin=Patch.esp&type=acti&limit=10");

        Assert.Equal(expected, EditorIds(activators.GetProperty("items")));
    }

    [Fact]
    public async Task APluginsWorldspaces_ListInFormIdOrder()
    {
        await LoadedListings();

        var worldspaces = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/worldspaces");

        Assert.Equal(["ZuluWorld", "AlphaWorld"], EditorIds(worldspaces));
    }

    [Fact]
    public async Task ASubBlocksCells_ListInFormIdOrder()
    {
        await LoadedListings();

        Assert.Equal(["ZuluClearing", "AlphaClearing"], EditorIds(await ExteriorSubBlockCells()));
    }

    [Fact]
    public async Task ACellsPlacedReferences_ListInFormIdOrder()
    {
        await LoadedListings();
        var room = (await InteriorBlocks())[1].GetProperty("subBlocks")[0].GetProperty("cells")[0];
        var roomFk = Uri.EscapeDataString(room.GetProperty("formKey").GetString().Require());

        var references = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/cells/{roomFk}/references");

        Assert.Equal(["ZuluRef", "AlphaRef"], EditorIds(references.GetProperty("temporary")));
    }

    [Fact]
    public async Task AQuestsChildren_ListInFormIdOrder_WhateverTheirType()
    {
        await LoadedListings();
        var quests = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={ListedPlugin}&type=qust&limit=10");
        var questFk = Uri.EscapeDataString(quests.GetProperty("items")[0].GetProperty("formKey").GetString().Require());

        var children = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/records/{questFk}/children");

        Assert.Equal(["ZuluScene", "AlphaTopic"], EditorIds(children));
    }

    [Fact]
    public async Task AWorldspace_SaysWhetherAnythingIsBeneathIt()
    {
        await LoadedListings();

        var worldspaces = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/worldspaces");

        Assert.Equal([true, false], worldspaces.EnumerateArray().Select(w => w.GetProperty("hasChildren").GetBoolean()));
    }

    [Fact]
    public async Task AnInteriorCell_SaysWhetherItHoldsAPlacedReference()
    {
        await LoadedListings();

        var rooms = (await InteriorBlocks())[1].GetProperty("subBlocks")[0].GetProperty("cells");

        Assert.Equal([true, false], rooms.EnumerateArray().Select(c => c.GetProperty("hasChildren").GetBoolean()));
    }

    [Fact]
    public async Task AnExteriorCell_SaysWhetherItHoldsAPlacedReference()
    {
        await LoadedListings();

        var clearings = await ExteriorSubBlockCells();

        Assert.Equal([true, false], clearings.EnumerateArray().Select(c => c.GetProperty("hasChildren").GetBoolean()));
    }

    [Fact]
    public async Task ARecordItsQuestHolds_IsListedOnlyBeneathItsQuest()
    {
        await Loaded();
        var types = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/record-types");
        var quests = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&type=qust&limit=10");
        var questFk = Uri.EscapeDataString(quests.GetProperty("items")[0].GetProperty("formKey").GetString().Require());

        var children = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/records/{questFk}/children");

        Assert.DoesNotContain("dial", types.EnumerateArray().Select(t => t.GetProperty("type").GetString()));
        Assert.Equal(["QueriedTopic"], EditorIds(children));
    }

    [Fact]
    public async Task TheCellGroup_CountsTheInteriorCellsItLists()
    {
        await Loaded();
        var types = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/record-types");
        var blocks = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/interior-cells");

        var cellGroup = types.EnumerateArray().Single(t => t.GetProperty("type").GetString() == "cell");
        var listed = blocks.EnumerateArray()
            .SelectMany(b => b.GetProperty("subBlocks").EnumerateArray())
            .Sum(s => s.GetProperty("cells").GetArrayLength());
        Assert.Equal(listed, cellGroup.GetProperty("count").GetInt32());
    }

    private async Task Filtered(string editorId) =>
        (await Client.PostAsJsonAsync("/load-order/filter",
            new { sql = $"SELECT form_key FROM records WHERE editor_id = '{editorId}'", source = "held.sql" }))
            .EnsureSuccessStatusCode();

    private static IEnumerable<string?> GroupNames(JsonElement types) =>
        types.EnumerateArray().Select(t => t.GetProperty("displayName").GetString());

    [Fact]
    public async Task ARecordFilterMatchingAPlacedReference_ListsTheCellHoldingIt_AndOnlyTheMatchBeneathIt()
    {
        await LoadedListings();
        await Filtered("ZuluRef");

        var types = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/record-types");
        var rooms = (await InteriorBlocks()).EnumerateArray()
            .SelectMany(b => b.GetProperty("subBlocks").EnumerateArray())
            .SelectMany(s => s.GetProperty("cells").EnumerateArray()).ToList();
        var roomFk = Uri.EscapeDataString(rooms[0].GetProperty("formKey").GetString().Require());
        var references = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/cells/{roomFk}/references");

        Assert.Equal(["Cell"], GroupNames(types));
        Assert.Equal(["ZuluRoom"], rooms.Select(r => r.GetProperty("editorId").GetString()));
        Assert.Equal(["ZuluRef"], EditorIds(references.GetProperty("temporary")));
    }

    [Fact]
    public async Task ARecordFilterMatchingAResponse_ListsTheQuestAndTopicAboveIt()
    {
        await Loaded();
        await Filtered("QueriedResponse");

        var types = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/record-types");
        var quests = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&type=qust&limit=10");
        var questFk = Uri.EscapeDataString(quests.GetProperty("items")[0].GetProperty("formKey").GetString().Require());
        var children = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/records/{questFk}/children");

        Assert.Equal(["Quest"], GroupNames(types));
        Assert.Equal(["QueriedTopic"], EditorIds(children));
    }

    [Fact]
    public async Task ARecordFilter_KeepsOnlyThePluginsHoldingAMatch_NotThoseHoldingOnlyItsHolders()
    {
        var fixture = Owned(new PluginFixtureBuilder("trace-query-filter-holders")
            .WithPlugin("Base.esm", mod =>
            {
                var room = new Cell(mod) { EditorID = "BaseRoom" };
                var subBlock = new CellSubBlock { BlockNumber = 0 };
                subBlock.Cells.Add(room);
                var block = new CellBlock { BlockNumber = 0 };
                block.SubBlocks.Add(subBlock);
                mod.Cells.Records.Add(block);
            }, origin: "BaseMod")
            .WithPlugin("Dressing.esp", (mod, masters) =>
            {
                var room = masters[0].Cells.Records[0].SubBlocks[0].Cells[0].DeepCopy();
                room.Temporary.Add(new PlacedObject(mod) { EditorID = "DressingRef" });
                var subBlock = new CellSubBlock { BlockNumber = 0 };
                subBlock.Cells.Add(room);
                var block = new CellBlock { BlockNumber = 0 };
                block.SubBlocks.Add(subBlock);
                mod.Cells.Records.Add(block);
            }, origin: "DressingMod")
            .BuildScattered());
        (await Client.PutLoadOrder(fixture)).EnsureSuccessStatusCode();
        await Filtered("DressingRef");

        var plugins = await Client.Plugins();

        Assert.Equal(
            ["Dressing.esp"],
            plugins.Where(p => p.GetProperty("hasMatchingRecords").GetBoolean()).Select(p => p.GetProperty("name").GetString()));
    }

    [Fact]
    public async Task ARecordFilter_ListsAHolderOnlyInThePluginWhoseCopyHoldsTheMatch()
    {
        var fixture = Owned(new PluginFixtureBuilder("trace-query-filter-own-holder")
            .WithPlugin("Base.esm", mod =>
            {
                var room = new Cell(mod) { EditorID = "BaseRoom" };
                room.Temporary.Add(new PlacedObject(mod) { EditorID = "BaseRef" });
                var subBlock = new CellSubBlock { BlockNumber = 0 };
                subBlock.Cells.Add(room);
                var block = new CellBlock { BlockNumber = 0 };
                block.SubBlocks.Add(subBlock);
                mod.Cells.Records.Add(block);
            }, origin: "BaseMod")
            .WithPlugin("Lighting.esp", (mod, masters) =>
            {
                var room = masters[0].Cells.Records[0].SubBlocks[0].Cells[0].DeepCopy();
                room.Temporary.Clear();
                room.WaterHeight = 10f;
                var subBlock = new CellSubBlock { BlockNumber = 0 };
                subBlock.Cells.Add(room);
                var block = new CellBlock { BlockNumber = 0 };
                block.SubBlocks.Add(subBlock);
                mod.Cells.Records.Add(block);
            }, origin: "LightingMod")
            .BuildScattered());
        (await Client.PutLoadOrder(fixture)).EnsureSuccessStatusCode();
        await Filtered("BaseRef");

        var baseRooms = await Client.GetFromJsonAsync<JsonElement>("/plugins/Base.esm/interior-cells");
        var lightingRooms = await Client.GetFromJsonAsync<JsonElement>("/plugins/Lighting.esp/interior-cells");

        Assert.Equal(["BaseRoom"], InteriorEditorIds(baseRooms));
        Assert.Empty(InteriorEditorIds(lightingRooms));
    }

    private static IEnumerable<string?> InteriorEditorIds(JsonElement blocks) =>
        blocks.EnumerateArray()
            .SelectMany(b => b.GetProperty("subBlocks").EnumerateArray())
            .SelectMany(s => s.GetProperty("cells").EnumerateArray())
            .Select(c => c.GetProperty("editorId").GetString());

    [Fact]
    public async Task AGroupsListing_HoldsAsManyRecordsAsItsCount()
    {
        await Loaded();
        var types = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/record-types");
        var cells = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&type=cell&limit=10");

        var count = types.EnumerateArray().Single(t => t.GetProperty("type").GetString() == "cell").GetProperty("count").GetInt32();
        Assert.Equal(count, cells.GetProperty("total").GetInt32());
        Assert.Equal(count, cells.GetProperty("items").GetArrayLength());
    }

    private const string HeldPlugin = "Held.esp";

    private async Task LoadedHeldRecords()
    {
        var fixture = Owned(new PluginFixtureBuilder("trace-query-held")
            .WithPlugin(HeldPlugin, mod =>
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
            }, origin: "HeldMod")
            .BuildScattered());
        (await Client.PutLoadOrder(fixture)).EnsureSuccessStatusCode();
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
        await LoadedHeldRecords();

        var types = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{HeldPlugin}/record-types");
        var group = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={HeldPlugin}&type={type}&limit=10");
        var held = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={HeldPlugin}&type={type}&search=Held&limit=10");

        Assert.Equal(1, held.GetProperty("total").GetInt32());
        Assert.Equal(0, group.GetProperty("total").GetInt32());
        Assert.DoesNotContain(type, types.EnumerateArray().Select(t => t.GetProperty("type").GetString()));
    }

    [Fact]
    public async Task AQuestionAboutARecordNoPluginHolds_IsAnsweredWithNothingFound()
    {
        await Loaded();
        var response = await Client.GetAsync(new Uri("/records/000FFF:Nowhere.esp", UriKind.Relative));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
