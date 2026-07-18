using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace MEditService.Tests.Api;

// #127: a save whose post-commit reindex fails must report success with a named reindex failure,
// not a 500. The file is written and the pending changes are consumed — only the index is stale.
public sealed class SaveChangeGroupReindexFailureApiTests(LoadedNpcReindexFailureApiFixture loaded)
    : IClassFixture<LoadedNpcReindexFailureApiFixture>
{
    private readonly HttpClient _client = loaded.Client;

    [Fact]
    public async Task SaveChangeGroup_WhenReindexFails_Returns200WithByPluginAndNamedReindexFailure()
    {
        var createResp = await _client.PostAsJsonAsync(
            $"/plugins/{Uri.EscapeDataString(TestPluginFixture.PluginName)}/records",
            new { recordType = "npc_", source = "user" });
        Assert.Equal(HttpStatusCode.OK, createResp.StatusCode);
        var created = JsonSerializer.Deserialize<JsonElement>(await createResp.Content.ReadAsStringAsync());
        var groupId = created.GetProperty("groupId").GetString();

        var saveResp = await _client.PostAsync($"/change-groups/{groupId}/save", null);

        // The save succeeded — reindex failure is a warning in the body, not a failed status.
        Assert.Equal(HttpStatusCode.OK, saveResp.StatusCode);
        var body = JsonSerializer.Deserialize<JsonElement>(await saveResp.Content.ReadAsStringAsync());

        // Per-plugin SaveResults survive, backup paths included.
        var byPlugin = body.GetProperty("byPlugin");
        Assert.True(byPlugin.GetProperty(TestPluginFixture.PluginName).TryGetProperty("backupPath", out _));

        // The reindex failure is named and structured, listing the affected plugin.
        var failure = body.GetProperty("reindexFailure");
        Assert.Equal(JsonValueKind.Object, failure.ValueKind);
        Assert.Contains(TestPluginFixture.PluginName,
            failure.GetProperty("plugins").EnumerateArray().Select(p => p.GetString()));
        Assert.False(string.IsNullOrEmpty(failure.GetProperty("reason").GetString()));

        // The save really happened: the pending changes are consumed, not left behind.
        Assert.Empty(await _client.GetFromJsonAsync<JsonElement[]>("/changes") ?? []);
    }
}
