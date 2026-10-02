using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.Api;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;
using Noggog;
using static MEditService.Http.Tests.Api.QueriedPluginsFixture;

namespace MEditService.Http.Tests.Traces;

/// <summary>query-index: a question and its answer are two arrows, and the Store is all the Queries
/// read, so every answer here is one the client asked for and got back.</summary>
public sealed class QueryIndexTraceTests : HostedTests
{
    private async Task LoadedQueriedPlugins() =>
        (await Client.PutLoadOrder(Owned(new QueriedPluginsFixture()).Data)).EnsureSuccessStatusCode();

    [Fact]
    public async Task AQuestionAboutTheCreatableRecordTypes_BeforeAnyLoadOrder_IsRefusedAsUnavailable()
    {
        var response = await Client.GetAsync(new Uri("/record-types/creatable", UriKind.Relative));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }

    [Fact]
    public async Task AQuestionAboutLightPluginsSupported_BeforeAnyLoadOrder_IsRefusedAsUnavailable()
    {
        var response = await Client.GetAsync(new Uri("/plugins/light-plugins-supported", UriKind.Relative));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
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

        var activators = await Client.GetFromJsonAsync<JsonElement>("/records?plugin=Localized.esp&origin=LocalizedMod&type=acti&limit=10");

        Assert.Equal("Lever", activators.GetProperty("items")[0].GetProperty("fullName").GetString());
    }

    [Fact]
    public async Task ALocalizedName_ReadsTheSameThroughTheSqlDoor()
    {
        await LoadedLocalized();

        (await Client.PostAsJsonAsync("/load-order/filter",
            new { sql = "SELECT form_key FROM \"acti\" WHERE \"Name\" = 'Lever'", source = "lever.sql" })).EnsureSuccessStatusCode();
        var activators = await Client.GetFromJsonAsync<JsonElement>("/records?plugin=Localized.esp&origin=LocalizedMod&type=acti&limit=10");

        Assert.Equal(1, activators.GetProperty("total").GetInt32());
    }

    private async Task<JsonElement> PlacedReferencesIn(string plugin, string origin)
    {
        var interiors = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{plugin}/interior-cells?origin={origin}");
        var cellFk = Uri.EscapeDataString(
            interiors[0].GetProperty("subBlocks")[0].GetProperty("cells")[0].GetProperty("formKey").GetString().Require());
        var references = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{plugin}/cells/{cellFk}/children?origin={origin}");
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

        var placed = await PlacedReferencesIn("Master.esm", "MasterMod");

        Assert.Equal("MasterLever", placed.GetProperty("baseEditorId").GetString());
    }

    [Fact]
    public async Task APlacedReference_WhosePluginHoldsNoCopyOfItsBase_NamesItAsTheWinningCopyDoes()
    {
        await LoadedWithTwoCopiesOfABase();

        var placed = await PlacedReferencesIn("Other.esp", "OtherMod");

        Assert.Equal("PatchLever", placed.GetProperty("baseEditorId").GetString());
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

        var activators = await Client.GetFromJsonAsync<JsonElement>("/records?plugin=Patch.esp&origin=PatchMod&type=acti&limit=10");

        Assert.Equal(["ZFullLever", "ALightLever"], EditorIds(activators.GetProperty("items")));
    }

    [Theory]
    [InlineData("FullTwin", "LightTwin", new[] { "ZTwinLever", "ALateLever" })]
    [InlineData("LightTwin", "FullTwin", new[] { "ALateLever", "ZTwinLever" })]
    public async Task AFilenamesFormIds_SortAsThePluginTheGameLoadsUnderIt_NotAnOverriddenCopy(
        string winnerOrigin, string loserOrigin, string[] expected)
    {
        static Action<Fallout4Mod> Twin(string origin) => mod =>
        {
            mod.IsSmallMaster = origin == "LightTwin";
            mod.Activators.AddNew("ZTwinLever");
        };
        var fixture = Owned(new PluginFixtureBuilder("trace-query-twin-order")
            .WithPlugin("Twin.esp", Twin(loserOrigin), origin: loserOrigin)
            .WithPlugin("Twin.esp", Twin(winnerOrigin), origin: winnerOrigin)
            .WithPlugin("Late.esm", mod => mod.Activators.AddNew("ALateLever"), origin: "LateMod")
            .WithPlugin("Patch.esp", (mod, masters) =>
            {
                mod.Activators.GetOrAddAsOverride(masters[1].Activators.Single());
                mod.Activators.GetOrAddAsOverride(masters[2].Activators.Single());
            }, origin: "PatchMod")
            .BuildScattered());
        (await Client.PutLoadOrder(fixture)).EnsureSuccessStatusCode();

        var activators = await Client.GetFromJsonAsync<JsonElement>("/records?plugin=Patch.esp&origin=PatchMod&type=acti&limit=10");

        Assert.Equal(expected, EditorIds(activators.GetProperty("items")));
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
        await LoadedQueriedPlugins();
        await Filtered("ZuluRef");

        var types = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/record-types?origin={ListedMod}");
        var rooms = (await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/interior-cells?origin={ListedMod}")).EnumerateArray()
            .SelectMany(b => b.GetProperty("subBlocks").EnumerateArray())
            .SelectMany(s => s.GetProperty("cells").EnumerateArray()).ToList();
        var roomFk = Uri.EscapeDataString(rooms[0].GetProperty("formKey").GetString().Require());
        var references = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{ListedPlugin}/cells/{roomFk}/children?origin={ListedMod}");

        Assert.Equal(["Cell"], GroupNames(types));
        Assert.Equal(["ZuluRoom"], rooms.Select(r => r.GetProperty("editorId").GetString()));
        Assert.Equal(["ZuluRef"], EditorIds(references.GetProperty("temporary")));
    }

    [Fact]
    public async Task ARecordFilterMatchingAResponse_ListsTheQuestAndTopicAboveIt()
    {
        await LoadedQueriedPlugins();
        await Filtered("QueriedResponse");

        var types = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/record-types?origin={UserMod}");
        var quests = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&origin={UserMod}&type=qust&limit=10");
        var questFk = Uri.EscapeDataString(quests.GetProperty("items")[0].GetProperty("formKey").GetString().Require());
        var children = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/records/{questFk}/children?origin={UserMod}");

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

        var baseRooms = await Client.GetFromJsonAsync<JsonElement>("/plugins/Base.esm/interior-cells?origin=BaseMod");
        var lightingRooms = await Client.GetFromJsonAsync<JsonElement>("/plugins/Lighting.esp/interior-cells?origin=LightingMod");

        Assert.Equal(["BaseRoom"], InteriorEditorIds(baseRooms));
        Assert.Empty(InteriorEditorIds(lightingRooms));
    }

    private static IEnumerable<string?> InteriorEditorIds(JsonElement blocks) =>
        blocks.EnumerateArray()
            .SelectMany(b => b.GetProperty("subBlocks").EnumerateArray())
            .SelectMany(s => s.GetProperty("cells").EnumerateArray())
            .Select(c => c.GetProperty("editorId").GetString());
}
