using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace MEditService.Tests.Api;

public sealed class FilterApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private Task ClearFilterAsync() => _client.DeleteAsync("/load-order/filter");

    // --- POST /load-order/filter ---

    [Fact]
    public async Task PostFilter_ValidSql_Returns200WithSql()
    {
        var resp = await _client.PostAsJsonAsync("/load-order/filter", new { sql = "SELECT form_key FROM \"NPC_\"" });
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("SELECT form_key FROM \"NPC_\"", body.GetProperty("sql").GetString());
    }

    [Fact]
    public async Task PostFilter_SqlWithoutFormKeyColumn_Returns400()
    {
        var resp = await _client.PostAsJsonAsync("/load-order/filter", new { sql = "SELECT editor_id FROM \"NPC_\"" });
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
    public async Task GetFilter_AfterPostFilter_ReturnsSql()
    {
        await _client.PostAsJsonAsync("/load-order/filter", new { sql = "SELECT form_key FROM \"NPC_\"" });

        var resp = await _client.GetAsync("/load-order/filter");
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("SELECT form_key FROM \"NPC_\"", body.GetProperty("sql").GetString());
    }

    // --- DELETE /load-order/filter ---

    [Fact]
    public async Task DeleteFilter_Returns204AndClearsFilter()
    {
        await _client.PostAsJsonAsync("/load-order/filter", new { sql = "SELECT form_key FROM \"NPC_\"" });

        var del = await _client.DeleteAsync("/load-order/filter");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        var get = await _client.GetAsync("/load-order/filter");
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
        await _client.PostAsJsonAsync("/load-order/filter",
            new { sql = "SELECT form_key FROM \"npc_\" LIMIT 1" });

        var filtered = await _client.GetFromJsonAsync<JsonElement>("/records?type=npc_&limit=100");
        var totalAfter = filtered.GetProperty("total").GetInt32();
        Assert.Equal(1, totalAfter);
    }

    // --- filter affects GET /plugins ---

    // ADR-0035 (amending ADR-0018): a record filter prunes records and record types, never a
    // plugin row, because this tree is also the load order and hiding a plugin mid-filter would
    // make it unreorderable. The plugin stays on the wire; hasMatchingRecords is the additive
    // fact a caller reads instead.
    [Fact]
    public async Task PostFilter_MatchingNoRecords_KeepsPluginInGetPluginsButFlagsNoMatch()
    {
        var pluginsBefore = await _client.GetFromJsonAsync<JsonElement[]>("/plugins");
        Assert.NotNull(pluginsBefore);
        Assert.NotEmpty(pluginsBefore);

        await _client.PostAsJsonAsync("/load-order/filter",
            new { sql = "SELECT 'NoMatch:000000' AS form_key" });

        var pluginsAfter = await _client.GetFromJsonAsync<JsonElement[]>("/plugins");
        Assert.NotNull(pluginsAfter);
        Assert.Equal(pluginsBefore!.Length, pluginsAfter!.Length);
        Assert.All(pluginsAfter, p => Assert.False(p.GetProperty("hasMatchingRecords").GetBoolean()));
    }

    [Fact]
    public async Task DeleteFilter_ThenGetPlugins_RestoresAllPlugins()
    {
        await _client.PostAsJsonAsync("/load-order/filter",
            new { sql = "SELECT 'NoMatch:000000' AS form_key" });
        await _client.DeleteAsync("/load-order/filter");

        var plugins = await _client.GetFromJsonAsync<JsonElement[]>("/plugins");
        Assert.NotNull(plugins);
        Assert.NotEmpty(plugins);
        Assert.All(plugins, p => Assert.True(p.GetProperty("hasMatchingRecords").GetBoolean()));
    }
}
