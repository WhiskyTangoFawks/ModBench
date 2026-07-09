using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace MEditService.Tests.Api;

public sealed class PluginSaveApiTests(LoadedNpcApiFixture loaded) : IClassFixture<LoadedNpcApiFixture>
{
    private readonly HttpClient _client = loaded.Client;

    [Fact]
    public async Task SaveGroups_AfterCreateRecord_Returns200WithBackupPath()
    {
        var createResp = await _client.PostAsJsonAsync(
            $"/plugins/{Uri.EscapeDataString(TestPluginFixture.PluginName)}/records",
            new { recordType = "npc_", source = "user" });
        Assert.Equal(HttpStatusCode.OK, createResp.StatusCode);

        var created = JsonSerializer.Deserialize<JsonElement>(await createResp.Content.ReadAsStringAsync());
        var groupId = created.GetProperty("groupId").GetString();
        Assert.NotNull(groupId);

        var saveResp = await _client.PostAsJsonAsync("/changes/groups/save", new[] { groupId });
        Assert.Equal(HttpStatusCode.OK, saveResp.StatusCode);

        var body = JsonSerializer.Deserialize<JsonElement>(await saveResp.Content.ReadAsStringAsync());
        var pluginResult = body.GetProperty(TestPluginFixture.PluginName);
        var backupPath = pluginResult.GetProperty("backupPath").GetString();
        Assert.NotNull(backupPath);
        Assert.True(File.Exists(backupPath));

        var afterChanges = await _client.GetFromJsonAsync<JsonElement[]>("/changes");
        Assert.Empty(afterChanges!);
    }

}
