using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

[Collection(WebHostCollection.Name)]
public sealed class FilterApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private Task ClearFilterAsync() => _client.DeleteAsync("/load-order/filter");

    // --- POST /load-order/filter ---

    [Fact]
    public async Task PostFilter_ValidSql_Returns200WithSql()
    {
        var resp = await _client.PostAsJsonAsync("/load-order/filter", new { sql = "SELECT form_key FROM \"NPC_\"", source = "npcs.sql" });
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("SELECT form_key FROM \"NPC_\"", body.GetProperty("sql").GetString());
    }

    [Fact]
    public async Task PostFilter_SqlWithoutFormKeyColumn_Returns400()
    {
        var resp = await _client.PostAsJsonAsync("/load-order/filter", new { sql = "SELECT editor_id FROM \"NPC_\"", source = "editor-ids.sql" });
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    // --- GET /load-order/filter ---

    [Fact]
    public async Task GetFilter_BeforeAnyFilter_ReturnsSqlNull()
    {
        await ClearFilterAsync();
        var resp = await _client.GetAsync("/load-order/filter");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, body.GetProperty("sql").ValueKind);
    }

    [Fact]
    public async Task GetFilter_AfterPostFilter_ReturnsTheSqlAndItsSource()
    {
        await _client.PostAsJsonAsync("/load-order/filter",
            new { sql = "SELECT form_key FROM \"NPC_\"", source = "npcs.sql" });

        var resp = await _client.GetAsync("/load-order/filter");
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("SELECT form_key FROM \"NPC_\"", body.GetProperty("sql").GetString());
        Assert.Equal("npcs.sql", body.GetProperty("source").GetString());
    }

    [Fact]
    public async Task PostFilter_WithoutASource_Returns400()
    {
        var resp = await _client.PostAsJsonAsync("/load-order/filter", new { sql = "SELECT form_key FROM \"NPC_\"" });
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    // --- DELETE /load-order/filter ---

    // plugins.md, Order and view state, story 5: the filter clears on purpose, whatever is held.
    [Fact]
    public async Task DeleteFilter_WithNoLoadOrder_Returns204()
    {
        await using var app = new MEditHost();

        var del = await app.CreateClient().DeleteAsync("/load-order/filter");

        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);
    }

    [Fact]
    public async Task DeleteFilter_Returns204AndClearsTheSqlAndItsSource()
    {
        await _client.PostAsJsonAsync("/load-order/filter",
            new { sql = "SELECT form_key FROM \"NPC_\"", source = "npcs.sql" });

        var del = await _client.DeleteAsync("/load-order/filter");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        var get = await _client.GetAsync("/load-order/filter");
        var body = await get.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, body.GetProperty("sql").ValueKind);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source").ValueKind);
    }

    // --- filter affects GET /records ---

    [Fact]
    public async Task PostFilter_ThenGetRecords_ReturnsFilteredSubset()
    {
        var allRecords = await _client.GetFromJsonAsync<JsonElement>("/records?type=npc_&limit=100");
        var totalBefore = allRecords.GetProperty("total").GetInt32();
        Assert.True(totalBefore > 1, $"Expected at least 2 NPC records, got {totalBefore}");

        // LIMIT 1 subquery — filters to exactly one record
        await _client.PostAsJsonAsync("/load-order/filter",
            new { sql = "SELECT form_key FROM \"npc_\" LIMIT 1", source = "one-npc.sql" });

        var filtered = await _client.GetFromJsonAsync<JsonElement>("/records?type=npc_&limit=100");
        var totalAfter = filtered.GetProperty("total").GetInt32();
        Assert.Equal(1, totalAfter);
    }

    // --- filter affects GET /plugins ---

    // plugins.md: a record filter never prunes a plugin row, because this tree is also the load
    // order and hiding a plugin mid-filter would make it unreorderable.
    [Fact]
    public async Task PostFilter_MatchingNoRecords_KeepsPluginInGetPluginsButFlagsNoMatch()
    {
        var pluginsBefore = await _client.GetFromJsonAsync<JsonElement[]>("/plugins");
        Assert.NotNull(pluginsBefore);
        Assert.NotEmpty(pluginsBefore);

        await _client.PostAsJsonAsync("/load-order/filter",
            new { sql = "SELECT 'NoMatch:000000' AS form_key", source = "nothing.sql" });

        var pluginsAfter = await _client.GetFromJsonAsync<JsonElement[]>("/plugins");
        Assert.NotNull(pluginsAfter);
        Assert.Equal(pluginsBefore.Length, pluginsAfter.Length);
        Assert.All(pluginsAfter, p => Assert.False(p.GetProperty("hasMatchingRecords").GetBoolean()));
    }

    [Fact]
    public async Task DeleteFilter_ThenGetPlugins_RestoresAllPlugins()
    {
        await _client.PostAsJsonAsync("/load-order/filter",
            new { sql = "SELECT 'NoMatch:000000' AS form_key", source = "nothing.sql" });
        await _client.DeleteAsync("/load-order/filter");

        var plugins = await _client.GetFromJsonAsync<JsonElement[]>("/plugins");
        Assert.NotNull(plugins);
        Assert.NotEmpty(plugins);
        Assert.All(plugins, p => Assert.True(p.GetProperty("hasMatchingRecords").GetBoolean()));
    }
}
