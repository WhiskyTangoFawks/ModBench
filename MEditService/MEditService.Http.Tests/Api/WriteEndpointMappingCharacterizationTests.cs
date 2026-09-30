using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

/// <summary>Status code and body shape for the write handlers' error-mapping paths the endpoint
/// suites do not reach, including the IO/UnauthorizedAccess to 500 mapping.</summary>
[Collection(WebHostCollection.Name)]
public sealed class WriteEndpointMappingCharacterizationTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private const string Origin = "EditableMod";
    private const string Plugin = "Editable.esp";
    private const string DestOrigin = "DestinationMod";
    private const string DestPlugin = "Destination.esp";

    private static ScatteredFixtureData BuildOneModOnePlugin() =>
        new PluginFixtureBuilder("api-604-one")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("ApiNpc"), origin: Origin)
            .BuildScattered();

    private static ScatteredFixtureData BuildSourceAndDestination() =>
        new PluginFixtureBuilder("api-604-two")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("ApiNpc"), origin: Origin)
            .WithPlugin(DestPlugin, mod => mod.Npcs.AddNew("DestNpc"), origin: DestOrigin)
            .BuildScattered();

    private async Task Load(ScatteredFixtureData fx)
    {
        var load = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Select(p => new { p.Name, p.Path, p.Origin }),
            active = SnapshotPlugins.Active(fx.Plugins),
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();
    }

    private async Task Track(string origin) =>
        (await _client.Track(origin == DestOrigin ? DestPlugin : Plugin, origin)).EnsureSuccessStatusCode();

    private async Task<string> FirstNpcFormKey(string plugin, string origin)
    {
        var records = await _client.GetFromJsonAsync<JsonElement>($"/records?plugin={plugin}&origin={origin}&type=npc_");
        return DocumentNodes.StringValueOf(records.GetProperty("items")[0].GetProperty("formKey"));
    }

    private static string ModFolderOf(ScatteredFixtureData fx, string origin)
    {
        var path = fx.Plugins.Single(p => p.Origin == origin).Path;
        return Path.GetDirectoryName(path)
            ?? throw new InvalidOperationException($"Expected '{path}' to have a parent directory.");
    }

    // --- DeleteRecord ---

    [Fact]
    public async Task DeleteRecord_WhenOneSourceFileCannotBeDeleted_RefusesThatRecord_AndDeletesTheRest()
    {
        using var fx = BuildSourceAndDestination();
        await Load(fx);
        await Track(Origin);
        await Track(DestOrigin);
        var locked = await FirstNpcFormKey(Plugin, Origin);
        var writable = await FirstNpcFormKey(DestPlugin, DestOrigin);
        var modFolder = ModFolderOf(fx, Origin);

        OtherTool.SetsThePermissions(modFolder, "500"); // read+execute only
        try
        {
            var response = await _client.PostAsJsonAsync("/records/delete", new
            {
                records = new[]
                {
                    new { formKey = locked, plugin = Plugin, origin = Origin },
                    new { formKey = writable, plugin = DestPlugin, origin = DestOrigin },
                },
            });

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            var applied = Assert.Single(body.GetProperty("applied").EnumerateArray().ToArray());
            Assert.Equal(writable, applied.GetProperty("formKey").GetString());
            var refused = Assert.Single(body.GetProperty("refused").EnumerateArray().ToArray());
            Assert.Equal(locked, refused.GetProperty("record").GetProperty("formKey").GetString());
            Assert.Equal("SourceWriteFailed", refused.GetProperty("refusal").GetString());
            Assert.False(string.IsNullOrWhiteSpace(refused.GetProperty("message").GetString()));
        }
        finally
        {
            OtherTool.SetsThePermissions(modFolder, "700"); // restored before fx.Dispose() needs to clean up
        }
    }

    [Fact]
    public async Task DeleteRecord_WithNoRecords_Is400()
    {
        var response = await _client.PostAsJsonAsync("/records/delete", new { records = Array.Empty<object>() });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task DeleteRecord_WithARecordMissingItsOrigin_Is400()
    {
        var response = await _client.PostAsJsonAsync("/records/delete", new
        {
            records = new[] { new { formKey = "000800:Editable.esp", plugin = Plugin, origin = "" } },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // --- EditRecord, of the FormID (200 already pinned by FormIdEditApiTests) ---

    [Fact]
    public async Task EditingTheFormId_OnAnUntrackedPlugin_IsRefusedWithATypedRefusal()
    {
        using var fx = BuildOneModOnePlugin();
        await Load(fx); // deliberately not tracked
        var formKey = await FirstNpcFormKey(Plugin, Origin);

        var response = await _client.Edit(formKey, Plugin, Origin, "FormKey", $"000F00:{Plugin}");

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("PluginNotTracked", problem.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task EditingTheFormId_WhenTheSourceCannotBeWritten_IsAShapedProblem_NotAnUnhandled500()
    {
        using var fx = BuildOneModOnePlugin();
        await Load(fx);
        await Track(Origin);
        var formKey = await FirstNpcFormKey(Plugin, Origin);
        var modFolder = ModFolderOf(fx, Origin);

        OtherTool.SetsThePermissions(modFolder, "500"); // read+execute only
        try
        {
            var response = await _client.Edit(formKey, Plugin, Origin, "FormKey", $"000F00:{Plugin}");

            Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
            var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.False(string.IsNullOrWhiteSpace(problem.GetProperty("detail").GetString()));
        }
        finally
        {
            OtherTool.SetsThePermissions(modFolder, "700"); // restored before fx.Dispose() needs to clean up
        }
    }

    // --- CopyRecord: a refusal is an item of the answer, never the status of the call ---

    [Theory]
    [InlineData("Override")]
    [InlineData("New")]
    public async Task CopyRecord_IntoATrackedDestination_AnswersTheItemApplied(string mode)
    {
        using var fx = BuildSourceAndDestination();
        await Load(fx);
        await Track(DestOrigin); // source deliberately left untracked: a copy reads an untracked source
        var formKey = await FirstNpcFormKey(Plugin, Origin);

        var response = await _client.Copy(formKey, (Plugin, Origin), mode, (DestPlugin, DestOrigin));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var landed = Assert.Single((await response.Body()).GetProperty("applied").EnumerateArray());
        Assert.Equal(formKey, landed.GetProperty("record").GetProperty("formKey").GetString());
        Assert.Equal(DestPlugin, landed.GetProperty("destination").GetProperty("name").GetString());
        Assert.Equal(DestOrigin, landed.GetProperty("destination").GetProperty("origin").GetString());
    }

    [Theory]
    [InlineData("Override")]
    [InlineData("New")]
    public async Task CopyRecord_IntoAnUntrackedDestination_AnswersTheItemRefusedWithATypedRefusal(string mode)
    {
        using var fx = BuildSourceAndDestination();
        await Load(fx); // destination deliberately left untracked
        var formKey = await FirstNpcFormKey(Plugin, Origin);

        var response = await _client.Copy(formKey, (Plugin, Origin), mode, (DestPlugin, DestOrigin));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var refused = Assert.Single((await response.Body()).GetProperty("refused").EnumerateArray());
        Assert.Equal("PluginNotTracked", refused.GetProperty("refusal").GetString());
    }

    [Theory]
    [InlineData("Override")]
    [InlineData("New")]
    public async Task CopyRecord_WhenTheDestinationCannotBeWritten_AnswersTheItemRefused_NotAnUnhandled500(string mode)
    {
        using var fx = BuildSourceAndDestination();
        await Load(fx);
        await Track(DestOrigin);
        var formKey = await FirstNpcFormKey(Plugin, Origin);
        var destModFolder = ModFolderOf(fx, DestOrigin);

        OtherTool.SetsThePermissions(destModFolder, "500"); // read+execute only
        try
        {
            var response = await _client.Copy(formKey, (Plugin, Origin), mode, (DestPlugin, DestOrigin));

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var refused = Assert.Single((await response.Body()).GetProperty("refused").EnumerateArray());
            Assert.Equal("SourceWriteFailed", refused.GetProperty("refusal").GetString());
            Assert.False(string.IsNullOrWhiteSpace(refused.GetProperty("message").GetString()));
        }
        finally
        {
            OtherTool.SetsThePermissions(destModFolder, "700"); // restored before fx.Dispose() needs to clean up
        }
    }

    [Fact]
    public async Task CopyRecord_WithNoDestination_Is400()
    {
        using var fx = BuildSourceAndDestination();
        await Load(fx);
        var formKey = await FirstNpcFormKey(Plugin, Origin);

        var response = await _client.Copy([(formKey, Plugin, Origin)], "Override", []);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // A copy as new lands under a FormID of its own, so it replaces nothing.
    [Fact]
    public async Task CopyRecord_AsNewWithTheReplaceOption_Is400_AndCopiesNothing()
    {
        using var fx = BuildSourceAndDestination();
        await Load(fx);
        await Track(DestOrigin);
        var formKey = await FirstNpcFormKey(Plugin, Origin);
        var destination = TreeSnapshot.Of(ModFolderOf(fx, DestOrigin));

        var response = await _client.Copy(formKey, (Plugin, Origin), "New", (DestPlugin, DestOrigin), replace: true);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(destination, TreeSnapshot.Of(ModFolderOf(fx, DestOrigin)));
    }

    // --- CreateRecord (400 already pinned by MalformedFormKeyEndpointTests; 200 incidentally by FormIdEditApiTests) ---

    [Fact]
    public async Task CreateRecord_OnAnUntrackedPlugin_IsRefusedWithATypedRefusal()
    {
        using var fx = BuildOneModOnePlugin();
        await Load(fx); // deliberately not tracked

        var response = await _client.PostAsJsonAsync($"/plugins/{Plugin}/records", new
        {
            origin = Origin,
            recordType = "npc_",
            editorId = "Untracked",
            formKey = (string?)null,
        });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("PluginNotTracked", problem.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task CreateRecord_WhenTheSourceFileCannotBeWritten_IsAShapedProblem_NotAnUnhandled500()
    {
        using var fx = BuildOneModOnePlugin();
        await Load(fx);
        await Track(Origin);
        var modFolder = ModFolderOf(fx, Origin);

        OtherTool.SetsThePermissions(modFolder, "500"); // read+execute only
        try
        {
            var response = await _client.PostAsJsonAsync($"/plugins/{Plugin}/records", new
            {
                origin = Origin,
                recordType = "npc_",
                editorId = "BrandNew",
                formKey = (string?)null,
            });

            Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
            var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.False(string.IsNullOrWhiteSpace(problem.GetProperty("detail").GetString()));
        }
        finally
        {
            OtherTool.SetsThePermissions(modFolder, "700"); // restored before fx.Dispose() needs to clean up
        }
    }
}
