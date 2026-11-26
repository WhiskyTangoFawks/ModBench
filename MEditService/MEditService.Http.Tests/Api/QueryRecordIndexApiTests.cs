using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using static MEditService.Http.Tests.Api.QueriedPluginsFixture;

namespace MEditService.Http.Tests.Api;

public sealed class QueryRecordIndexApiTests(LoadedApiFixture<QueriedPluginsFixture> loaded)
    : IClassFixture<LoadedApiFixture<QueriedPluginsFixture>>
{
    private HttpClient Client => loaded.Client;

    [Theory]
    [InlineData("plugin=Any.esp")]
    [InlineData("origin=AnyMod")]
    public async Task ARecordListNamingOnlyHalfAPluginsAddress_IsRefused(string half)
    {
        var response = await Client.GetAsync($"/records?{half}&type=npc_");

        var problem = await response.AssertIsProblem(HttpStatusCode.BadRequest);
        Assert.Equal(
            "Name a plugin with both plugin and origin, or neither to browse every plugin.",
            problem.GetProperty("detail").GetString());
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
    public async Task AQuestionAboutOnePluginsRecordTypes_IsAnsweredWithEachTypeAndItsName()
    {
        var types = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/record-types?origin={UserMod}");

        var npcs = types.EnumerateArray().Single(t => t.GetProperty("type").GetString() == "npc_");
        Assert.Equal("Non-Player Character", npcs.GetProperty("displayName").GetString());
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
    public async Task ACellsChildRecordTypes_AreAnsweredWithEachTypesName()
    {
        var worldspaces = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/worldspaces?origin={UserMod}");
        var worldFk = Uri.EscapeDataString(worldspaces[0].GetProperty("formKey").GetString().Require());
        var blocks = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/worldspaces/{worldFk}/blocks?origin={UserMod}");
        var exterior = blocks.GetProperty("blocks")[0].GetProperty("subBlocks")[0].GetProperty("cells")[0].GetProperty("formKey").GetString().Require();

        Assert.Equal(["Landscape", "Navmesh", .. PlacedRecordTables.DisplayNames], await ChildRecordTypeNames(exterior));
    }

    private async Task<IEnumerable<string?>> ChildRecordTypeNames(string formKey)
    {
        var types = await Client.GetFromJsonAsync<JsonElement>(
            $"/plugins/{UserPlugin}/records/{Uri.EscapeDataString(formKey)}/child-record-types?origin={UserMod}");
        return types.EnumerateArray().Select(t => t.GetProperty("displayName").GetString());
    }

    [Theory]
    [InlineData("type=acti&type=kywd", new[] { "QueriedKeyword", "QueriedLever" }, false)]
    [InlineData("", new[] { "QueriedKeyword", "QueriedLever", "QueriedNpc" }, true)]
    public async Task ARecordSearch_NamingSeveralTypesOrNone_ListsTheRecordsOfEachOfThem(
        string types, string[] expectedAmong, bool listsTheNpc)
    {
        var page = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&origin={UserMod}&limit=50&{types}");

        var listed = EditorIds(page.GetProperty("items")).Order().ToList();
        Assert.All(expectedAmong, id => Assert.Contains(id, listed));
        Assert.Equal(listsTheNpc, listed.Contains("QueriedNpc"));
    }

    [Fact]
    public async Task TheRecordTypesOfARecordThePluginDoesNotHold_AreAnsweredWithNothingFound()
    {
        var response = await Client.GetAsync($"/plugins/{UserPlugin}/records/000FFF%3ANowhere.esp/child-record-types?origin={UserMod}");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task TheOwnersOfARecordNoPluginHolds_AreNone()
    {
        var owners = await Client.GetFromJsonAsync<JsonElement>(new Uri("/records/000FFF:Nowhere.esp/owners", UriKind.Relative));

        Assert.Equal(0, owners.GetArrayLength());
    }

    [Fact]
    public async Task AComparisonOfARecordNoPluginHolds_IsAnsweredWithNothingFound()
    {
        var response = await Client.GetAsync(new Uri("/records/000FFF:Nowhere.esp/compare", UriKind.Relative));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task APluginTheRecordIndexHasRead_IsIndexedAsOnDisk()
    {
        var indexed = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/indexed-as-on-disk?origin={UserMod}");

        Assert.Equal("AsOnDisk", indexed.GetProperty("state").GetString());
    }

    [Fact]
    public async Task ThePluginsListingAFileNameAsAMaster_AreItsDependants()
    {
        var answer = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/dependants?origin={UserMod}");

        var dependant = Assert.Single(answer.GetProperty("dependants").EnumerateArray());
        Assert.Equal((ChildPlugin, ChildMod), (dependant.GetProperty("name").GetString(), dependant.GetProperty("origin").GetString()));
    }

    [Fact]
    public async Task TheReferencesToAPluginName_AreEachCopyThatNamesIt()
    {
        var answer = await Client.GetFromJsonAsync<JsonElement>($"/plugin-names/{UserPlugin}/references");

        Assert.Contains(answer.EnumerateArray(), NamesTheChildsHeader);
    }

    [Fact]
    public async Task ThePlacedReferencesToAPluginName_AreEachCopyThatNamesIt()
    {
        var answer = await Client.GetFromJsonAsync<JsonElement>($"/plugin-names/{UserPlugin}/placed-references");

        Assert.Contains(answer.GetProperty("copies").EnumerateArray(), NamesTheChildsHeader);
    }

    private static bool NamesTheChildsHeader(JsonElement copy) =>
        copy.GetProperty("formKey").GetString() == $"000000:{ChildPlugin}" && copy.GetProperty("plugin").GetProperty("origin").GetString() == ChildMod;

    [Fact]
    public async Task TheReferencesToAScript_AreEachCopyThatAttachesIt_AtItsFieldPath()
    {
        var answer = await Client.GetFromJsonAsync<JsonElement>("/script-names/Attached/references");

        Assert.Contains(answer.GetProperty("copies").EnumerateArray(), copy => copy.GetProperty("plugin").GetProperty("origin").GetString() == UserMod
            && copy.GetProperty("fieldPaths").EnumerateArray().Select(path => path.GetString()).SequenceEqual(["VirtualMachineAdapter.Scripts[0].Name"]));
    }

    [Theory]
    [InlineData("/script-names/Attached/placed-references")]
    [InlineData("/file-paths/placed-references?path=Textures/Decals/Stain_d.dds")]
    public async Task ThePlacedReferencesToAScriptOrAFile_AreEachCopyThatNamesItAtItsRanges(string route)
    {
        var answer = await Client.GetFromJsonAsync<JsonElement>(route);

        Assert.Contains(answer.GetProperty("copies").EnumerateArray(), copy => copy.GetProperty("plugin").GetProperty("origin").GetString() == UserMod
            && copy.GetProperty("ranges").GetArrayLength() == 1);
    }

    private async Task<string> FormKeyOf(string type) =>
        (await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&origin={UserMod}&type={type}"))
            .GetProperty("items")[0].GetProperty("formKey").GetString().Require();

    private static object CopyIn(string formKey) => new { formKey, plugin = new { name = UserPlugin, origin = UserMod } };

    [Fact]
    public async Task SeveralRecords_AreOneColumnEach_InTheOrderGiven_WithNoConflictState()
    {
        var (keyword, npc) = (await FormKeyOf("kywd"), await FormKeyOf("npc_"));

        var response = await Client.PostAsJsonAsync("/records/compare", new { copies = new[] { CopyIn(keyword), CopyIn(npc) } });

        var answer = (await Wire.Answer(response)).GetProperty("compare");
        var columns = answer.GetProperty("overrides").EnumerateArray().ToList();
        Assert.Equal([keyword, npc], columns.Select(c => c.GetProperty("formKey").GetString()));
        Assert.All(columns, c => Assert.False(c.TryGetProperty("conflictThis", out var state) && state.ValueKind != JsonValueKind.Null));
    }

    [Fact]
    public async Task ManyRecords_AreAnsweredWithEachCopysState_AndNoFields()
    {
        var (keyword, npc) = (await FormKeyOf("kywd"), await FormKeyOf("npc_"));

        var response = await Client.PostAsJsonAsync("/records/copy-states", new { formKeys = new[] { keyword, npc } });

        var records = (await Wire.Answer(response)).EnumerateArray().ToList();
        Assert.Equal([keyword, npc], records.Select(r => r.GetProperty("formKey").GetString()));
        var copy = Assert.Single(records[0].GetProperty("copies").EnumerateArray());
        Assert.Equal((UserPlugin, "OnlyOne"), (copy.GetProperty("plugin").GetProperty("name").GetString(), copy.GetProperty("conflictThis").GetString()));
        Assert.Equal(["conflictThis", "plugin"], copy.EnumerateObject().Select(p => p.Name).Order());
    }

    [Fact]
    public async Task OneRecordWithAPluginsText_IsThatPluginsColumnReadFromIt()
    {
        var response = await Client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(await FormKeyOf("kywd"))}/compare",
            new { plugin = new { name = UserPlugin, origin = UserMod }, documentText = "{ not json" });

        var column = (await Wire.Answer(response)).GetProperty("overrides").EnumerateArray().Single();
        Assert.Equal((UserPlugin, UserMod), (column.GetProperty("plugin").GetString(), column.GetProperty("origin").GetString()));
        Assert.False(string.IsNullOrWhiteSpace(column.GetProperty("parseDiagnosis").GetString()));
    }

    [Fact]
    public async Task OneRecordNoPluginIndexes_WithAText_Is404()
    {
        var response = await Client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString("00DEAD:Nowhere.esp")}/compare",
            new { plugin = new { name = UserPlugin, origin = UserMod }, documentText = "{}" });

        await response.AssertIsProblem(HttpStatusCode.NotFound);
    }
}
