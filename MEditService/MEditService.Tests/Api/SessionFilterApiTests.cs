using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace MEditService.Tests.Api;

public sealed class SessionFilterApiTests : IClassFixture<LoadedNpcApiFixture>
{
    private readonly HttpClient _client;

    public SessionFilterApiTests(LoadedNpcApiFixture loaded)
    {
        _client = loaded.Client;
    }

    private Task ClearFilterAsync() => _client.DeleteAsync("/session/filter");

    // --- POST /session/filter ---

    [Fact]
    public async Task PostFilter_ValidSql_Returns200WithSql()
    {
        var resp = await _client.PostAsJsonAsync("/session/filter", new { sql = "SELECT form_key FROM \"NPC_\"" });
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("SELECT form_key FROM \"NPC_\"", body.GetProperty("sql").GetString());
    }

    [Fact]
    public async Task PostFilter_SqlWithoutFormKeyColumn_Returns400()
    {
        var resp = await _client.PostAsJsonAsync("/session/filter", new { sql = "SELECT editor_id FROM \"NPC_\"" });
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    // --- GET /session/filter ---

    [Fact]
    public async Task GetFilter_BeforeAnyFilter_ReturnsSqlNull()
    {
        await ClearFilterAsync();
        var resp = await _client.GetAsync("/session/filter");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, body.GetProperty("sql").ValueKind);
    }

    [Fact]
    public async Task GetFilter_AfterPostFilter_ReturnsSql()
    {
        await _client.PostAsJsonAsync("/session/filter", new { sql = "SELECT form_key FROM \"NPC_\"" });

        var resp = await _client.GetAsync("/session/filter");
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("SELECT form_key FROM \"NPC_\"", body.GetProperty("sql").GetString());
    }

    // --- DELETE /session/filter ---

    [Fact]
    public async Task DeleteFilter_Returns204AndClearsFilter()
    {
        await _client.PostAsJsonAsync("/session/filter", new { sql = "SELECT form_key FROM \"NPC_\"" });

        var del = await _client.DeleteAsync("/session/filter");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        var get = await _client.GetAsync("/session/filter");
        var body = await get.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, body.GetProperty("sql").ValueKind);
    }

    // --- filter affects GET /records ---

    [Fact]
    public async Task PostFilter_ThenGetRecords_ReturnsFilteredSubset()
    {
        var allRecords = await _client.GetFromJsonAsync<JsonElement>("/records?type=npc_&limit=100");
        var totalBefore = allRecords.GetProperty("total").GetInt32();
        Assert.True(totalBefore > 1, $"Expected at least 2 NPC records, got {totalBefore}");

        // LIMIT 1 subquery — filters to exactly one record
        await _client.PostAsJsonAsync("/session/filter",
            new { sql = "SELECT form_key FROM \"npc_\" LIMIT 1" });

        var filtered = await _client.GetFromJsonAsync<JsonElement>("/records?type=npc_&limit=100");
        var totalAfter = filtered.GetProperty("total").GetInt32();
        Assert.Equal(1, totalAfter);
    }

    // --- filter affects GET /plugins ---

    [Fact]
    public async Task PostFilter_MatchingNoRecords_HidesPluginFromGetPlugins()
    {
        var pluginsBefore = await _client.GetFromJsonAsync<JsonElement[]>("/plugins");
        Assert.NotNull(pluginsBefore);
        Assert.NotEmpty(pluginsBefore);

        await _client.PostAsJsonAsync("/session/filter",
            new { sql = "SELECT 'NoMatch:000000' AS form_key" });

        var pluginsAfter = await _client.GetFromJsonAsync<JsonElement[]>("/plugins");
        Assert.NotNull(pluginsAfter);
        Assert.Empty(pluginsAfter);
    }

    [Fact]
    public async Task DeleteFilter_ThenGetPlugins_RestoresAllPlugins()
    {
        await _client.PostAsJsonAsync("/session/filter",
            new { sql = "SELECT 'NoMatch:000000' AS form_key" });
        await _client.DeleteAsync("/session/filter");

        var plugins = await _client.GetFromJsonAsync<JsonElement[]>("/plugins");
        Assert.NotNull(plugins);
        Assert.NotEmpty(plugins);
    }
}
