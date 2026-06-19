using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace MEditService.Tests.Api;

public sealed class SaveChangeGroupApiTests : IClassFixture<LoadedNpcApiFixture>
{
    private readonly HttpClient _client;

    public SaveChangeGroupApiTests(LoadedNpcApiFixture loaded)
    {
        _client = loaded.Client;
    }

    [Fact]
    public async Task SaveChangeGroup_AfterCreateRecord_Returns200AndClearsGroup()
    {
        var createResp = await _client.PostAsJsonAsync(
            $"/plugins/{Uri.EscapeDataString(TestPluginFixture.PluginName)}/records",
            new { recordType = "npc_", source = "user" });
        Assert.Equal(HttpStatusCode.OK, createResp.StatusCode);

        var created = JsonSerializer.Deserialize<JsonElement>(await createResp.Content.ReadAsStringAsync());
        var groupId = created.GetProperty("groupId").GetString();
        Assert.NotNull(groupId);

        var saveResp = await _client.PostAsync($"/change-groups/{groupId}/save", null);
        Assert.Equal(HttpStatusCode.OK, saveResp.StatusCode);

        var body = JsonSerializer.Deserialize<JsonElement>(await saveResp.Content.ReadAsStringAsync());
        Assert.True(body.GetProperty(TestPluginFixture.PluginName).TryGetProperty("backupPath", out _));

        var afterChanges = await _client.GetFromJsonAsync<JsonElement[]>("/changes");
        Assert.Empty(afterChanges!);
    }

    [Fact]
    public async Task SaveChangeGroup_UnknownGroupId_Returns404()
    {
        var saveResp = await _client.PostAsync($"/change-groups/{Guid.NewGuid()}/save", null);
        Assert.Equal(HttpStatusCode.NotFound, saveResp.StatusCode);
    }
}
