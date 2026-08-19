using System.Net;
using System.Net.Http.Json;

namespace MEditService.Tests.Api;

public sealed class ImmutablePluginApiTests(LoadedApiFixture<ImmutablePluginFixture> loaded) : IClassFixture<LoadedApiFixture<ImmutablePluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;
    private readonly ImmutablePluginFixture _fixture = loaded.Plugin;

    [Fact]
    public async Task GetPlugins_ImmutablePlugin_HasIsImmutableTrue()
    {
        var plugins = await _client.GetFromJsonAsync<System.Text.Json.JsonElement[]>("/plugins");
        Assert.NotNull(plugins);

        var fo4 = plugins.Single(p =>
            string.Equals(p.GetProperty("name").GetString(),
                ImmutablePluginFixture.ImmutablePluginName,
                StringComparison.OrdinalIgnoreCase));

        Assert.True(fo4.GetProperty("isImmutable").GetBoolean());
    }

    [Fact]
    public async Task CreatePlugin_CreatesFileAndReturnsPlugin()
    {
        var resp = await _client.PostAsJsonAsync("/plugins/create", new { name = "NewMod.esp" });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var plugin = await resp.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        Assert.Equal("NewMod.esp", plugin.GetProperty("name").GetString());
        Assert.False(plugin.GetProperty("isImmutable").GetBoolean());

        Assert.True(File.Exists(Path.Combine(_fixture.DataFolder, "NewMod.esp")));

        var plugins = await _client.GetFromJsonAsync<System.Text.Json.JsonElement[]>("/plugins");
        Assert.NotNull(plugins);
        Assert.Contains(plugins, p =>
            string.Equals(p.GetProperty("name").GetString(), "NewMod.esp", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task CreatePlugin_DuplicateName_Returns409()
    {
        var resp1 = await _client.PostAsJsonAsync("/plugins/create", new { name = "DupMod.esp" });
        Assert.Equal(HttpStatusCode.OK, resp1.StatusCode);

        var resp2 = await _client.PostAsJsonAsync("/plugins/create", new { name = "DupMod.esp" });
        Assert.Equal(HttpStatusCode.Conflict, resp2.StatusCode);
    }

    [Fact]
    public async Task CreatePlugin_InvalidExtension_Returns400()
    {
        var resp = await _client.PostAsJsonAsync("/plugins/create", new { name = "BadMod.txt" });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

}
