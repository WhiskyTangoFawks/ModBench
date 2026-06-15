using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

[Collection("ApiTests")]
public sealed class SessionFilterApiTests : IClassFixture<TestPluginFixture>
{
    private readonly TestPluginFixture _fixture;
    private readonly WebApplicationFactory<Program> _app;

    public SessionFilterApiTests(TestPluginFixture fixture, ApiWebAppFixture webApp)
    {
        _fixture = fixture;
        _app = webApp.App;
    }

    private async Task<HttpClient> LoadedClient()
    {
        var client = _app.CreateClient();
        var resp = await client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = _fixture.DataFolder,
            pluginsTxtPath = _fixture.PluginsTxtPath,
            gameRelease = "Fallout4",
        });
        resp.EnsureSuccessStatusCode();
        return client;
    }

    // --- POST /session/filter ---

    [Fact]
    public async Task PostFilter_ValidSql_Returns200WithSql()
    {
        var client = await LoadedClient();
        var resp = await client.PostAsJsonAsync("/session/filter", new { sql = "SELECT form_key FROM \"NPC_\"" });
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("SELECT form_key FROM \"NPC_\"", body.GetProperty("sql").GetString());
    }

    [Fact]
    public async Task PostFilter_SqlWithoutFormKeyColumn_Returns400()
    {
        var client = await LoadedClient();
        var resp = await client.PostAsJsonAsync("/session/filter", new { sql = "SELECT editor_id FROM \"NPC_\"" });
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    // --- GET /session/filter ---

    [Fact]
    public async Task GetFilter_BeforeAnyFilter_ReturnsSqlNull()
    {
        var client = await LoadedClient();
        var resp = await client.GetAsync("/session/filter");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, body.GetProperty("sql").ValueKind);
    }

    [Fact]
    public async Task GetFilter_AfterPostFilter_ReturnsSql()
    {
        var client = await LoadedClient();
        await client.PostAsJsonAsync("/session/filter", new { sql = "SELECT form_key FROM \"NPC_\"" });

        var resp = await client.GetAsync("/session/filter");
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("SELECT form_key FROM \"NPC_\"", body.GetProperty("sql").GetString());
    }

    // --- DELETE /session/filter ---

    [Fact]
    public async Task DeleteFilter_Returns204AndClearsFilter()
    {
        var client = await LoadedClient();
        await client.PostAsJsonAsync("/session/filter", new { sql = "SELECT form_key FROM \"NPC_\"" });

        var del = await client.DeleteAsync("/session/filter");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        var get = await client.GetAsync("/session/filter");
        var body = await get.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(JsonValueKind.Null, body.GetProperty("sql").ValueKind);
    }

    // --- filter affects GET /records ---

    [Fact]
    public async Task PostFilter_ThenGetRecords_ReturnsFilteredSubset()
    {
        var client = await LoadedClient();

        var allRecords = await client.GetFromJsonAsync<JsonElement>("/records?type=npc_&limit=100");
        var totalBefore = allRecords.GetProperty("total").GetInt32();
        Assert.True(totalBefore > 1, $"Expected at least 2 NPC records, got {totalBefore}");

        // LIMIT 1 subquery — filters to exactly one record
        await client.PostAsJsonAsync("/session/filter",
            new { sql = "SELECT form_key FROM \"npc_\" LIMIT 1" });

        var filtered = await client.GetFromJsonAsync<JsonElement>("/records?type=npc_&limit=100");
        var totalAfter = filtered.GetProperty("total").GetInt32();
        Assert.Equal(1, totalAfter);
    }

    // --- filter affects GET /plugins ---

    [Fact]
    public async Task PostFilter_MatchingNoRecords_HidesPluginFromGetPlugins()
    {
        var client = await LoadedClient();

        var pluginsBefore = await client.GetFromJsonAsync<JsonElement[]>("/plugins");
        Assert.NotNull(pluginsBefore);
        Assert.NotEmpty(pluginsBefore);

        await client.PostAsJsonAsync("/session/filter",
            new { sql = "SELECT 'NoMatch:000000' AS form_key" });

        var pluginsAfter = await client.GetFromJsonAsync<JsonElement[]>("/plugins");
        Assert.NotNull(pluginsAfter);
        Assert.Empty(pluginsAfter);
    }

    [Fact]
    public async Task DeleteFilter_ThenGetPlugins_RestoresAllPlugins()
    {
        var client = await LoadedClient();

        await client.PostAsJsonAsync("/session/filter",
            new { sql = "SELECT 'NoMatch:000000' AS form_key" });
        await client.DeleteAsync("/session/filter");

        var plugins = await client.GetFromJsonAsync<JsonElement[]>("/plugins");
        Assert.NotNull(plugins);
        Assert.NotEmpty(plugins);
    }
}
