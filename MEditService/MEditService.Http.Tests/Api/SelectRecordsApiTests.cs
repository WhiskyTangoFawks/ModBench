using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class SelectRecordsApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    [Fact]
    public async Task PostSelect_ReturnsTheRowsItSelects()
    {
        var response = await _client.PostAsJsonAsync("/records/select", new { sql = "SELECT editor_id FROM npc_ WHERE editor_id = 'TestNPC02'" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var rows = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("rows");
        Assert.Equal("TestNPC02", Assert.Single(rows.EnumerateArray()).GetProperty("editor_id").GetString());
    }

    [Fact]
    public async Task PostSelect_SqlTheDoorRefuses_Returns400SayingWhy()
    {
        var response = await _client.PostAsJsonAsync("/records/select", new { sql = "SELECT * FROM information_schema.tables" });

        var problem = await response.AssertIsProblem(HttpStatusCode.BadRequest);
        Assert.Contains("information_schema", problem.GetProperty("detail").GetString(), StringComparison.Ordinal);
    }
}
