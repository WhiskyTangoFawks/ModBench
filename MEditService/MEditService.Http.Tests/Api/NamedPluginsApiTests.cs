using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class NamedPluginsApiTests : HostedTests
{
    [Theory]
    [InlineData("/plugins/facts")]
    [InlineData("/plugins/indexing")]
    public async Task PluginsNamedByNameAndOrigin_AreTheOnlyPluginsAnswered(string path)
    {
        var fx = Owned(new PluginFixtureBuilder("api-plugin-facts")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("A"), origin: "ModA")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("B"), origin: "ModB")
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var response = await Client.PostAsJsonAsync(path, new { plugins = new[] { new { name = "Shared.esp", origin = "ModB" } } });

        var answered = Assert.Single((await response.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray());
        Assert.Equal("ModB", answered.GetProperty("origin").GetString());
    }

    [Theory]
    [InlineData("/plugins/facts", "{}")]
    [InlineData("/plugins/facts", "{\"plugins\":[{\"name\":\"Shared.esp\"}]}")]
    [InlineData("/plugins/facts", "{\"plugins\":[{\"origin\":\"ModB\"}]}")]
    [InlineData("/plugins/indexing", "{}")]
    [InlineData("/plugins/indexing", "{\"plugins\":[{\"name\":\"Shared.esp\"}]}")]
    public async Task APluginsFieldMissingOrAPluginWithoutNameAndOrigin_IsRefusedAs400(string path, string body)
    {
        using var content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");

        var response = await Client.PostAsync(path, content);

        Assert.Equal(System.Net.HttpStatusCode.BadRequest, response.StatusCode);
    }
}
