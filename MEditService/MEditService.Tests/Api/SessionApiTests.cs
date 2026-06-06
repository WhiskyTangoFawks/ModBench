using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

[Collection("ApiTests")]
public sealed class SessionApiTests : IClassFixture<TestPluginFixture>
{
    private readonly TestPluginFixture _fixture;
    private readonly WebApplicationFactory<Program> _app;

    public SessionApiTests(TestPluginFixture fixture, ApiWebAppFixture webApp)
    {
        _fixture = fixture;
        _app = webApp.App;
    }

    [Fact]
    public async Task PostSessionLoad_WithRealPlugin_Returns200()
    {
        var client = _app.CreateClient();

        var response = await client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = _fixture.DataFolder,
            pluginsTxtPath = _fixture.PluginsTxtPath,
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task PostSessionLoad_ThenGetPlugins_ReturnsLoadedPlugin()
    {
        var client = _app.CreateClient();

        var load = await client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = _fixture.DataFolder,
            pluginsTxtPath = _fixture.PluginsTxtPath,
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();

        var plugins = await client.GetFromJsonAsync<List<dynamic>>("/plugins");

        Assert.NotNull(plugins);
        Assert.Single(plugins);
    }

    [Fact]
    public async Task PostSessionLoad_ThenGetRecords_ReturnsIndexedRecords()
    {
        var client = _app.CreateClient();

        var load = await client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = _fixture.DataFolder,
            pluginsTxtPath = _fixture.PluginsTxtPath,
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();

        var records = await client.GetFromJsonAsync<dynamic>($"/records?type=NPC_&limit=10");

        Assert.NotNull(records);
    }
}
