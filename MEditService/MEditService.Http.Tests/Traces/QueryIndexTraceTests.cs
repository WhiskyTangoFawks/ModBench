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
            ["Activator", "Cell", "Dialog response", "Dialog Topic", "Keyword", "Non-Player Character", "Placed Object", "Quest", "Worldspace"],
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
        var interiors = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/interior-cells?limit=50&offset=0");

        var worldFk = Uri.EscapeDataString(worldspaces[0].GetProperty("formKey").GetString().Require());
        var blocks = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/worldspaces/{worldFk}/blocks");

        Assert.Equal("Queried World", worldspaces[0].GetProperty("fullName").GetString());
        Assert.Equal(
            "Queried Clearing",
            blocks.GetProperty("blocks")[0].GetProperty("subBlocks")[0].GetProperty("cells")[0].GetProperty("fullName").GetString());
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

    private async Task<JsonElement> PlacedReferencesIn(string plugin)
    {
        var interiors = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{plugin}/interior-cells?limit=50&offset=0");
        var cellFk = Uri.EscapeDataString(interiors.GetProperty("items")[0].GetProperty("formKey").GetString().Require());
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

    [Fact]
    public async Task AQuestionAboutARecordNoPluginHolds_IsAnsweredWithNothingFound()
    {
        await Loaded();
        var response = await Client.GetAsync(new Uri("/records/000FFF:Nowhere.esp", UriKind.Relative));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
