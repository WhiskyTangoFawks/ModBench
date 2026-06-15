using System.Net;
using System.Net.Http.Json;

namespace MEditService.Tests.Api;

public sealed class SessionApiTests : IClassFixture<LoadedNpcApiFixture>
{
    private readonly HttpClient _client;
    private readonly TestPluginFixture _fixture;

    public SessionApiTests(LoadedNpcApiFixture loaded)
    {
        _client = loaded.Client;
        _fixture = loaded.Plugin;
    }

    [Fact]
    public async Task PostSessionLoad_Returns200AndLoadsPlugin()
    {
        var response = await _client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = _fixture.DataFolder,
            pluginsTxtPath = _fixture.PluginsTxtPath,
            gameRelease = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var plugins = await _client.GetFromJsonAsync<List<dynamic>>("/plugins");
        Assert.NotNull(plugins);
        Assert.Single(plugins);
    }

    [Fact]
    public async Task PostSessionLoad_ThenGetRecords_ReturnsIndexedRecords()
    {
        var load = await _client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = _fixture.DataFolder,
            pluginsTxtPath = _fixture.PluginsTxtPath,
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();

        var records = await _client.GetFromJsonAsync<dynamic>($"/records?type=NPC_&limit=10");

        Assert.NotNull(records);
    }
}
