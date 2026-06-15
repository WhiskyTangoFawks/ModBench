using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace MEditService.Tests.Api;

public sealed class PluginSaveApiTests : IClassFixture<LoadedNpcApiFixture>
{
    private readonly HttpClient _client;
    private readonly TestPluginFixture _fixture;

    public PluginSaveApiTests(LoadedNpcApiFixture loaded)
    {
        _client = loaded.Client;
        _fixture = loaded.Plugin;
    }

    [Fact]
    public async Task Save_AfterPatch_Returns200WithBackupPath()
    {
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        await _client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        var saveResp = await _client.PostAsync(
            $"/plugins/{Uri.EscapeDataString(TestPluginFixture.PluginName)}/save", null);
        Assert.Equal(HttpStatusCode.OK, saveResp.StatusCode);

        var body = JsonSerializer.Deserialize<JsonElement>(await saveResp.Content.ReadAsStringAsync());
        var backupPath = body.GetProperty("backupPath").GetString();
        Assert.NotNull(backupPath);
        Assert.True(File.Exists(backupPath));

        var afterChanges = await _client.GetFromJsonAsync<JsonElement[]>("/changes");
        Assert.Empty(afterChanges!);
    }
}
