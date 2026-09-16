using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Tests.Api;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Traces;

/// <summary>query: a question and its answer are two arrows, and the Store is all the Queries
/// read, so every answer here is one the client asked for and got back.</summary>
[Collection(WebHostCollection.Name)]
public sealed class QueryTraceTests : IAsyncLifetime, IDisposable
{
    private const string UserPlugin = "UserMod.esp";
    private const string ImmutablePlugin = "Fallout4.esm";
    private const string UserMod = "UserModFolder";

    private readonly MEditHost _app = new();
    private readonly HttpClient _client;
    private readonly ScatteredFixtureData _instance = new PluginFixtureBuilder("trace-query")
        .WithPlugin(ImmutablePlugin, listed: false)
        .WithPlugin(UserPlugin, mod =>
        {
            mod.Npcs.AddNew("QueriedNpc").HeightMax = 0.5f;
            mod.Keywords.AddNew("QueriedKeyword");
        }, origin: UserMod)
        .BuildScattered();

    public QueryTraceTests() => _client = _app.CreateClient();

    public async Task InitializeAsync() => (await _client.PutLoadOrder(_instance)).EnsureSuccessStatusCode();

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
        _instance.Dispose();
    }

    [Fact]
    public async Task AQuestionAboutAPluginsRecords_IsAnsweredWithTheRowsAndThenTheRecord()
    {
        var page = await _client.GetFromJsonAsync<JsonElement>($"/records?plugin={UserPlugin}&type=npc_&limit=10");

        Assert.Equal(1, page.GetProperty("total").GetInt32());
        var summary = page.GetProperty("items")[0];
        Assert.Equal("QueriedNpc", summary.GetProperty("editorId").GetString());

        var detail = await _client.Record(summary.GetProperty("formKey").GetString().Require());
        Assert.Equal("QueriedNpc", detail.GetProperty("editorId").GetString());
        var height = detail.GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == "HeightMax");
        Assert.Equal(0.5, height.GetProperty("value").GetDouble(), 3);
    }

    [Fact]
    public async Task AQuestionAboutThePlugins_NamesTheOneNoEditCanTouch()
    {
        var plugins = await _client.Plugins();

        Assert.True((await _client.Plugin(ImmutablePlugin)).GetProperty("isImmutable").GetBoolean());
        Assert.False((await _client.Plugin(UserPlugin)).GetProperty("isImmutable").GetBoolean());
        Assert.Equal(2, plugins.Count);
    }

    [Fact]
    public async Task AQuestionAboutOnePluginsRecordTypes_CountsWhatItHolds()
    {
        var types = await _client.GetFromJsonAsync<JsonElement>($"/plugins/{UserPlugin}/record-types");

        var counts = types.EnumerateArray().ToDictionary(
            t => t.GetProperty("type").GetString().Require(), t => t.GetProperty("count").GetInt32());
        Assert.Equal(1, counts["npc_"]);
        Assert.Equal(1, counts["kywd"]);
    }

    [Fact]
    public async Task AQuestionAboutARecordNoPluginHolds_IsAnsweredWithNothingFound()
    {
        var response = await _client.GetAsync(new Uri("/records/000FFF:Nowhere.esp", UriKind.Relative));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
