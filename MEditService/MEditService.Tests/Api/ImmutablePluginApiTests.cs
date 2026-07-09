using System.Net;
using System.Net.Http.Json;

namespace MEditService.Tests.Api;

public sealed class ImmutablePluginApiTests(LoadedImmutableApiFixture loaded) : IClassFixture<LoadedImmutableApiFixture>
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
    public async Task Patch_ImmutablePlugin_Returns409()
    {
        var formKey = Uri.EscapeDataString(_fixture.UserNpcFormKey.ToString());

        var resp = await _client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = ImmutablePluginFixture.ImmutablePluginName,
            fields = new Dictionary<string, object?> { ["editor_id"] = "Hacked" },
            source = "user",
        });

        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
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

    [Fact]
    public async Task PostPluginRecords_ImmutablePlugin_Returns409()
    {
        var plugin = Uri.EscapeDataString(ImmutablePluginFixture.ImmutablePluginName);

        var resp = await _client.PostAsJsonAsync($"/plugins/{plugin}/records", new
        {
            recordType = "npc_",
            source = "user",
        });

        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }
}
