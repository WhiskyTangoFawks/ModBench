using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class ResolveNamesApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    [Fact]
    public async Task PostResolve_AnswersEachNameAsThePluginOrRecordItMeans()
    {
        var response = await _client.PostAsJsonAsync("/names/resolve", new { names = new[] { new { name = TestPluginFixture.PluginName }, new { name = "TestNPC02" } } });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var named = (await response.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray().ToList();
        Assert.Equal(TestPluginFixture.PluginName, named[0].GetProperty("plugin").GetProperty("name").GetString());
        Assert.Equal("Data/", named[0].GetProperty("plugin").GetProperty("origin").GetString());
        Assert.Equal("TestNPC02", named[1].GetProperty("editorId").GetString());
    }
}
