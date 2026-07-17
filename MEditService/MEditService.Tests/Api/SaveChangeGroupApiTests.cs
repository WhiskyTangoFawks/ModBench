using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace MEditService.Tests.Api;

public sealed class SaveChangeGroupApiTests(LoadedNpcApiFixture loaded) : IClassFixture<LoadedNpcApiFixture>
{
    private readonly HttpClient _client = loaded.Client;

    // The fixture is shared across the class, so tests that run earlier can leave pending changes
    // behind — every one of them is now a group, where before most were invisible to /change-groups.
    private async Task ClearChangesAsync()
    {
        foreach (var g in await _client.GetFromJsonAsync<JsonElement[]>("/change-groups") ?? [])
            await _client.DeleteAsync($"/changes/group/{g.GetProperty("id").GetString()}");
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

    // Issue #112 end to end, over the same surface the Pending Changes tree uses. An ordinary field
    // edit staged with group_id = NULL had no change_groups row, so it could never appear in
    // /change-groups and — since every save path keyed on a group id — could never be written to
    // disk either. It is a group of one now, and saves like any other.
    [Fact]
    public async Task SaveChangeGroup_AfterOrdinaryFieldEdit_ReachesDiskAndConsumesPendingRow()
    {
        await ClearChangesAsync();
        var formKey = loaded.Plugin.Npc1FormKey.ToString();
        var patchResp = await _client.PatchAsJsonAsync($"/records/{Uri.EscapeDataString(formKey)}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });
        Assert.Equal(HttpStatusCode.OK, patchResp.StatusCode);

        // Reachable at all: the edit is a group, discovered the way the tree discovers it.
        var groups = await _client.GetFromJsonAsync<JsonElement[]>("/change-groups") ?? [];
        var group = Assert.Single(groups, g => g.GetProperty("operation").GetString() == "field_edit");
        Assert.Equal(1, group.GetProperty("changeCount").GetInt32());

        var saveResp = await _client.PostAsync($"/change-groups/{group.GetProperty("id").GetString()}/save", null);
        Assert.Equal(HttpStatusCode.OK, saveResp.StatusCode);

        // Savable at all: the value is committed, and the pending row is consumed rather than left
        // behind. Re-reading the record surfaces the saved value, not a still-pending overlay.
        Assert.Empty(await _client.GetFromJsonAsync<JsonElement[]>("/changes") ?? []);
        var record = await _client.GetFromJsonAsync<JsonElement>($"/records/{Uri.EscapeDataString(formKey)}");
        Assert.Equal("Frenzied", record.GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == "aggression")
            .GetProperty("value").GetString());
    }
}
