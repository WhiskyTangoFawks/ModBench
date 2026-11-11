using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class SelectRecordsApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private Task<HttpResponseMessage> Select(string sql) => _client.PostAsJsonAsync("/records/select", new { sql });

    private static async Task<string[]> LinesOf(HttpResponseMessage response) =>
        (await response.Content.ReadAsStringAsync()).Split('\n', StringSplitOptions.RemoveEmptyEntries);

    [Fact]
    public async Task PostSelect_SendsEachRowAsALine_ThenTheLineThatEndsThem()
    {
        var response = await Select("SELECT editor_id FROM npc_ WHERE editor_id IN ('TestNPC01', 'TestNPC02') ORDER BY editor_id");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/x-ndjson", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal(
            ["""{"row":{"editor_id":"TestNPC01"}}""", """{"row":{"editor_id":"TestNPC02"}}""", """{"end":true}"""],
            await LinesOf(response));
    }

    [Fact]
    public async Task PostSelect_RefusedBeforeItsFirstRow_AnswersTheProblem()
    {
        var response = await Select("SELECT no_such_column FROM npc_");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("SelectRejected", problem.GetProperty("refusal").GetString());
        Assert.Contains("no_such_column", problem.GetProperty("detail").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task PostSelect_StoppedAfterItsFirstRow_SendsTheRefusalAsItsLastLine()
    {
        var response = await Select("SELECT CAST(CASE WHEN n < 1000000 THEN '1' ELSE 'x' END AS INTEGER) AS v FROM range(2000000) t(n)");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var lines = await LinesOf(response);
        Assert.Equal("""{"row":{"v":1}}""", lines[0]);
        using var last = JsonDocument.Parse(lines[^1]);
        Assert.Equal("SelectRejected", last.RootElement.GetProperty("refusal").GetString());
        Assert.Contains("Could not convert string 'x'", last.RootElement.GetProperty("detail").GetString(), StringComparison.Ordinal);
    }
}
