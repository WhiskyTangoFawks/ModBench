using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

[Collection("ApiTests")]
public sealed class ImmutablePluginApiTests : IClassFixture<ImmutablePluginFixture>
{
    private readonly ImmutablePluginFixture _fixture;
    private readonly WebApplicationFactory<Program> _app;

    public ImmutablePluginApiTests(ImmutablePluginFixture fixture, ApiWebAppFixture webApp)
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

    [Fact]
    public async Task GetPlugins_ImmutablePlugin_HasIsImmutableTrue()
    {
        var client = await LoadedClient();

        var plugins = await client.GetFromJsonAsync<System.Text.Json.JsonElement[]>("/plugins");
        Assert.NotNull(plugins);

        var fo4 = plugins.Single(p =>
            string.Equals(p.GetProperty("name").GetString(),
                ImmutablePluginFixture.ImmutablePluginName,
                StringComparison.OrdinalIgnoreCase));

        Assert.True(fo4.GetProperty("isImmutable").GetBoolean());
    }

    [Theory]
    [InlineData("patch")]
    [InlineData("save")]
    [InlineData("copy")]
    public async Task Write_ImmutablePlugin_Returns409(string op)
    {
        var client = await LoadedClient();
        var formKey = Uri.EscapeDataString(_fixture.UserNpcFormKey.ToString());
        var plugin = Uri.EscapeDataString(ImmutablePluginFixture.ImmutablePluginName);

        var resp = op switch
        {
            "patch" => await client.PatchAsJsonAsync($"/records/{formKey}", new
            {
                plugin = ImmutablePluginFixture.ImmutablePluginName,
                fields = new Dictionary<string, object?> { ["editor_id"] = "Hacked" },
                source = "user",
            }),
            "save" => await client.PostAsync($"/plugins/{plugin}/save", null),
            _ => await client.PostAsync($"/records/{formKey}/copy-to/{plugin}", null),
        };

        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }

    [Fact]
    public async Task CreatePlugin_CreatesFileAndReturnsPlugin()
    {
        var client = await LoadedClient();

        var resp = await client.PostAsJsonAsync("/plugins/create", new { name = "NewMod.esp" });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var plugin = await resp.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        Assert.Equal("NewMod.esp", plugin.GetProperty("name").GetString());
        Assert.False(plugin.GetProperty("isImmutable").GetBoolean());

        // File exists on disk
        Assert.True(File.Exists(Path.Combine(_fixture.DataFolder, "NewMod.esp")));

        // Appears in live session
        var plugins = await client.GetFromJsonAsync<System.Text.Json.JsonElement[]>("/plugins");
        Assert.NotNull(plugins);
        Assert.Contains(plugins, p =>
            string.Equals(p.GetProperty("name").GetString(), "NewMod.esp", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task CreatePlugin_DuplicateName_Returns409()
    {
        var client = await LoadedClient();

        // First create
        var resp1 = await client.PostAsJsonAsync("/plugins/create", new { name = "DupMod.esp" });
        Assert.Equal(HttpStatusCode.OK, resp1.StatusCode);

        // Second create with same name — already exists
        var resp2 = await client.PostAsJsonAsync("/plugins/create", new { name = "DupMod.esp" });
        Assert.Equal(HttpStatusCode.Conflict, resp2.StatusCode);
    }

    [Fact]
    public async Task CreatePlugin_InvalidExtension_Returns400()
    {
        var client = await LoadedClient();

        var resp = await client.PostAsJsonAsync("/plugins/create", new { name = "BadMod.txt" });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }
}
