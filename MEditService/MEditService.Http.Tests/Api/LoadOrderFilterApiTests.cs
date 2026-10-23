using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class FilterApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private Task ClearFilterAsync() => _client.DeleteAsync("/load-order/filter");

    [Fact]
    public async Task PostFilter_ValidSql_Returns204()
    {
        var resp = await _client.SetFilter();
        Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
    }

    [Fact]
    public async Task PostFilter_SqlNamingAColumnNoRelationHas_Returns400SayingWhy()
    {
        var resp = await _client.PostAsJsonAsync("/load-order/filter", new { sql = "SELECT form_key FROM \"NPC_\" WHERE no_such_column = 1", source = "wrong.sql" });

        var problem = await resp.AssertIsProblem(HttpStatusCode.BadRequest);
        Assert.Contains("no_such_column", problem.GetProperty("detail").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task GetFilter_WithNoFilterInForce_Returns204()
    {
        await ClearFilterAsync();
        var resp = await _client.GetAsync("/load-order/filter");
        Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
    }

    [Fact]
    public async Task GetFilter_AfterPostFilter_ReturnsTheSqlAndItsSource()
    {
        await _client.SetFilter();

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

    [Fact]
    public async Task DeleteFilter_WithNoLoadOrder_Returns204()
    {
        await using var app = new MEditHost();

        var del = await app.CreateClient().DeleteAsync("/load-order/filter");

        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);
    }

    [Fact]
    public async Task DeleteFilter_AfterAPostFilter_Returns204()
    {
        await _client.PostAsJsonAsync("/load-order/filter",
            new { sql = "SELECT form_key FROM \"NPC_\"", source = "npcs.sql" });

        var del = await _client.DeleteAsync("/load-order/filter");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);
    }
}
