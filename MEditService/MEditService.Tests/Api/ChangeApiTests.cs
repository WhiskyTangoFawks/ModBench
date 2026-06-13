using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Core.Edits;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Tests.Api;

[Collection("ApiTests")]
public sealed class ChangeApiTests : IClassFixture<TestPluginFixture>
{
    private readonly TestPluginFixture _fixture;
    private readonly WebApplicationFactory<Program> _app;

    public ChangeApiTests(TestPluginFixture fixture, ApiWebAppFixture webApp)
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
    public async Task Patch_ValidField_Returns200()
    {
        var client = await LoadedClient();
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        var resp = await client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    }

    [Fact]
    public async Task Patch_ThenGetChanges_ReturnsStoredChange()
    {
        var client = await LoadedClient();
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        await client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        var changes = await client.GetFromJsonAsync<JsonElement[]>("/changes");
        Assert.NotNull(changes);
        Assert.NotEmpty(changes);
    }

    [Fact]
    public async Task GetChanges_FilteredByPlugin_ReturnsMatchingOnly()
    {
        var client = await LoadedClient();
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        await client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        var matching = await client.GetFromJsonAsync<JsonElement[]>(
            $"/changes?plugin={Uri.EscapeDataString(TestPluginFixture.PluginName)}");
        Assert.NotNull(matching);
        Assert.NotEmpty(matching);

        var noMatch = await client.GetFromJsonAsync<JsonElement[]>("/changes?plugin=NonExistent.esp");
        Assert.NotNull(noMatch);
        Assert.Empty(noMatch);
    }

    [Fact]
    public async Task DeleteChange_ById_Returns204AndRemovesChange()
    {
        var client = await LoadedClient();
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        await client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        var changesJson = await client.GetStringAsync("/changes");
        var changes = JsonSerializer.Deserialize<JsonElement[]>(changesJson)!;
        var id = changes[0].GetProperty("id").GetString();

        var del = await client.DeleteAsync($"/changes/{id}");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        var after = await client.GetFromJsonAsync<JsonElement[]>("/changes");
        Assert.Empty(after!);
    }

    [Fact]
    public async Task BulkDeleteChanges_ByFormKeyAndPlugin_ClearsRecord()
    {
        var client = await LoadedClient();
        var rawFormKey = _fixture.Npc1FormKey.ToString();
        var formKey = Uri.EscapeDataString(rawFormKey);

        await client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        var del = await client.DeleteAsync(
            $"/changes?plugin={Uri.EscapeDataString(TestPluginFixture.PluginName)}&formKey={formKey}");
        Assert.Equal(HttpStatusCode.OK, del.StatusCode);

        var after = await client.GetFromJsonAsync<JsonElement[]>("/changes");
        Assert.Empty(after!);
    }

    [Fact]
    public async Task Compare_ConflictEnums_SerializedAsStrings()
    {
        var client = await LoadedClient();
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        var compareJson = await client.GetStringAsync($"/records/{formKey}/compare");
        var compare = JsonSerializer.Deserialize<JsonElement>(compareJson);

        var conflictAll = compare.GetProperty("conflictAll");
        Assert.Equal(JsonValueKind.String, conflictAll.ValueKind);
        Assert.NotEmpty(conflictAll.GetString()!);

        foreach (var ov in compare.GetProperty("overrides").EnumerateArray())
        {
            var conflictThis = ov.GetProperty("conflictThis");
            Assert.Equal(JsonValueKind.String, conflictThis.ValueKind);
            Assert.NotEmpty(conflictThis.GetString()!);
        }
    }

    private async Task<(HttpClient client, IPendingChangeService svc)> LoadedClientWithService()
    {
        var client = await LoadedClient();
        var svc = _app.Services.GetRequiredService<IPendingChangeService>();
        return (client, svc);
    }

    private static GroupMember ApiMember(string formKey, string plugin, string fieldPath) =>
        new(formKey, plugin, "npc_", "create", fieldPath,
            JsonDocument.Parse("null").RootElement.Clone(),
            JsonDocument.Parse("\"x\"").RootElement.Clone());

    [Fact]
    public async Task GetChangeGroups_WhenNoGroups_ReturnsEmptyList()
    {
        var client = await LoadedClient();

        var resp = await client.GetFromJsonAsync<JsonElement[]>("/change-groups");

        Assert.NotNull(resp);
        Assert.Empty(resp);
    }

    [Fact]
    public async Task DeleteChangeGroup_NotFound_Returns404()
    {
        var client = await LoadedClient();

        var resp = await client.DeleteAsync($"/changes/group/{Guid.NewGuid()}");

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task DeleteChangeGroup_RevokesAllChangesAtomically()
    {
        var (client, svc) = await LoadedClientWithService();
        var members = new[] { ApiMember("FK-G1", "Test.esp", "name"), ApiMember("FK-G2", "Test.esp", "name") };
        var group = svc.StageGroup("create", null, members);

        var del = await client.DeleteAsync($"/changes/group/{group.Id}");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        var changes = await client.GetFromJsonAsync<JsonElement[]>($"/changes?groupId={group.Id}");
        Assert.Empty(changes!);
        var groups = await client.GetFromJsonAsync<JsonElement[]>("/change-groups");
        Assert.Empty(groups!);
    }

    [Fact]
    public async Task DeleteChange_GroupOwned_Returns409WithGroupIdInDetail()
    {
        var (client, svc) = await LoadedClientWithService();
        var members = new[] { ApiMember("FK-GO", "Test.esp", "name") };
        var group = svc.StageGroup("create", null, members);
        var changeId = svc.GetChanges(formKey: "FK-GO")[0].Id;

        var resp = await client.DeleteAsync($"/changes/{changeId}");

        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
        var body = JsonDocument.Parse(await resp.Content.ReadAsStringAsync()).RootElement;
        Assert.Contains(group.Id.ToString(), body.GetProperty("detail").GetString()!);
    }

    [Fact]
    public async Task Patch_RecordWithPendingGroupChange_Returns409WithGroupInDetail()
    {
        var (client, svc) = await LoadedClientWithService();
        var rawFormKey = _fixture.Npc1FormKey.ToString();
        var members = new[] { ApiMember(rawFormKey, TestPluginFixture.PluginName, "name") };
        svc.StageGroup("create", null, members);

        var resp = await client.PatchAsJsonAsync($"/records/{Uri.EscapeDataString(rawFormKey)}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
        var body = JsonDocument.Parse(await resp.Content.ReadAsStringAsync()).RootElement;
        Assert.Contains("group", body.GetProperty("detail").GetString()!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Compare_AfterPatch_IncludesPendingFields()
    {
        var client = await LoadedClient();
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        await client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        var compareJson = await client.GetStringAsync($"/records/{formKey}/compare");
        var compare = JsonSerializer.Deserialize<JsonElement>(compareJson);
        var overrides = compare.GetProperty("overrides");

        var hasPendingFields = false;
        foreach (var ov in overrides.EnumerateArray())
        {
            if (ov.TryGetProperty("pendingFields", out var pf) && pf.ValueKind != JsonValueKind.Null)
                hasPendingFields = true;
        }
        Assert.True(hasPendingFields);
    }
}
