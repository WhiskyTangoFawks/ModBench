using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

[Collection("ApiTests")]
public sealed class PluginSaveApiTests : IClassFixture<TestPluginFixture>
{
    private readonly TestPluginFixture _fixture;
    private readonly WebApplicationFactory<Program> _app;

    public PluginSaveApiTests(TestPluginFixture fixture, ApiWebAppFixture webApp)
    {
        _fixture = fixture;
        _app = webApp.App;
    }

    [Fact]
    public async Task Save_AfterPatch_Returns200WithBackupPath()
    {
        var client = _app.CreateClient();
        var resp = await client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = _fixture.DataFolder,
            pluginsTxtPath = _fixture.PluginsTxtPath,
            gameRelease = "Fallout4",
        });
        resp.EnsureSuccessStatusCode();

        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        await client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        var saveResp = await client.PostAsync(
            $"/plugins/{Uri.EscapeDataString(TestPluginFixture.PluginName)}/save", null);
        Assert.Equal(HttpStatusCode.OK, saveResp.StatusCode);

        var body = JsonSerializer.Deserialize<JsonElement>(await saveResp.Content.ReadAsStringAsync());
        var backupPath = body.GetProperty("backupPath").GetString();
        Assert.NotNull(backupPath);
        Assert.True(File.Exists(backupPath));

        var afterChanges = await client.GetFromJsonAsync<JsonElement[]>("/changes");
        Assert.Empty(afterChanges!);
    }
}
