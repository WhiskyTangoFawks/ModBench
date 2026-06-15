using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Core.Edits;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Tests.Api;

public sealed class ChangeApiTests : IClassFixture<LoadedNpcApiFixture>
{
    private readonly HttpClient _client;
    private readonly TestPluginFixture _fixture;
    private readonly IServiceProvider _services;

    public ChangeApiTests(LoadedNpcApiFixture loaded)
    {
        _client = loaded.Client;
        _fixture = loaded.Plugin;
        _services = loaded.Services;
    }

    private IPendingChangeService GetService() =>
        _services.GetRequiredService<IPendingChangeService>();

    private async Task ClearChangesAsync()
    {
        var groups = await _client.GetFromJsonAsync<JsonElement[]>("/change-groups") ?? [];
        foreach (var g in groups)
            await _client.DeleteAsync($"/changes/group/{g.GetProperty("id").GetString()}");
        var changes = await _client.GetFromJsonAsync<JsonElement[]>("/changes") ?? [];
        foreach (var c in changes)
            await _client.DeleteAsync($"/changes/{c.GetProperty("id").GetString()}");
    }

    private static GroupMember ApiMember(string formKey, string plugin, string fieldPath) =>
        new(formKey, plugin, "npc_", "create", fieldPath,
            JsonDocument.Parse("null").RootElement.Clone(),
            JsonDocument.Parse("\"x\"").RootElement.Clone());

    [Fact]
    public async Task Patch_ValidField_Returns200()
    {
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        var resp = await _client.PatchAsJsonAsync($"/records/{formKey}", new
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
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        await _client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        var changes = await _client.GetFromJsonAsync<JsonElement[]>("/changes");
        Assert.NotNull(changes);
        Assert.NotEmpty(changes);
    }

    [Fact]
    public async Task GetChanges_FilteredByPlugin_ReturnsMatchingOnly()
    {
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        await _client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        var matching = await _client.GetFromJsonAsync<JsonElement[]>(
            $"/changes?plugin={Uri.EscapeDataString(TestPluginFixture.PluginName)}");
        Assert.NotNull(matching);
        Assert.NotEmpty(matching);

        var noMatch = await _client.GetFromJsonAsync<JsonElement[]>("/changes?plugin=NonExistent.esp");
        Assert.NotNull(noMatch);
        Assert.Empty(noMatch);
    }

    [Fact]
    public async Task DeleteChange_ById_Returns204AndRemovesChange()
    {
        await ClearChangesAsync();
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        await _client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        var changesJson = await _client.GetStringAsync("/changes");
        var changes = JsonSerializer.Deserialize<JsonElement[]>(changesJson)!;
        var id = changes[0].GetProperty("id").GetString();

        var del = await _client.DeleteAsync($"/changes/{id}");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        var after = await _client.GetFromJsonAsync<JsonElement[]>("/changes");
        Assert.Empty(after!);
    }

    [Fact]
    public async Task BulkDeleteChanges_ByFormKeyAndPlugin_ClearsRecord()
    {
        await ClearChangesAsync();
        var rawFormKey = _fixture.Npc1FormKey.ToString();
        var formKey = Uri.EscapeDataString(rawFormKey);

        await _client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        var del = await _client.DeleteAsync(
            $"/changes?plugin={Uri.EscapeDataString(TestPluginFixture.PluginName)}&formKey={formKey}");
        Assert.Equal(HttpStatusCode.OK, del.StatusCode);

        var after = await _client.GetFromJsonAsync<JsonElement[]>("/changes");
        Assert.Empty(after!);
    }

    [Fact]
    public async Task Compare_ConflictEnums_SerializedAsStrings()
    {
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        var compareJson = await _client.GetStringAsync($"/records/{formKey}/compare");
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

    [Fact]
    public async Task GetChangeGroups_WhenNoGroups_ReturnsEmptyList()
    {
        await ClearChangesAsync();

        var resp = await _client.GetFromJsonAsync<JsonElement[]>("/change-groups");

        Assert.NotNull(resp);
        Assert.Empty(resp);
    }

    [Fact]
    public async Task DeleteChangeGroup_NotFound_Returns404()
    {
        var resp = await _client.DeleteAsync($"/changes/group/{Guid.NewGuid()}");

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task DeleteChangeGroup_RevokesAllChangesAtomically()
    {
        await ClearChangesAsync();
        var svc = GetService();
        var members = new[] { ApiMember("FK-G1", "Test.esp", "name"), ApiMember("FK-G2", "Test.esp", "name") };
        var group = svc.StageGroup("create", null, members);

        var del = await _client.DeleteAsync($"/changes/group/{group.Id}");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        var changes = await _client.GetFromJsonAsync<JsonElement[]>($"/changes?groupId={group.Id}");
        Assert.Empty(changes!);
        var groups = await _client.GetFromJsonAsync<JsonElement[]>("/change-groups");
        Assert.Empty(groups!);
    }

    [Fact]
    public async Task DeleteChange_GroupOwned_Returns409WithGroupIdInDetail()
    {
        var svc = GetService();
        var members = new[] { ApiMember("FK-GO", "Test.esp", "name") };
        var group = svc.StageGroup("create", null, members);
        var changeId = svc.GetChanges(formKey: "FK-GO")[0].Id;

        var resp = await _client.DeleteAsync($"/changes/{changeId}");

        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
        var body = JsonDocument.Parse(await resp.Content.ReadAsStringAsync()).RootElement;
        Assert.Contains(group.Id.ToString(), body.GetProperty("detail").GetString()!);
    }

    [Fact]
    public async Task Patch_RecordWithPendingGroupChange_Returns409WithGroupInDetail()
    {
        await ClearChangesAsync();
        var svc = GetService();
        var rawFormKey = _fixture.Npc1FormKey.ToString();
        var members = new[] { ApiMember(rawFormKey, TestPluginFixture.PluginName, "name") };
        svc.StageGroup("create", null, members);

        var resp = await _client.PatchAsJsonAsync($"/records/{Uri.EscapeDataString(rawFormKey)}", new
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
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        await _client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        var compareJson = await _client.GetStringAsync($"/records/{formKey}/compare");
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

    [Fact]
    public async Task PostPluginRecords_NoTemplate_Returns200WithCreateRecordResult()
    {
        var plugin = Uri.EscapeDataString(TestPluginFixture.PluginName);

        var resp = await _client.PostAsJsonAsync($"/plugins/{plugin}/records", new
        {
            recordType = "npc_",
            source = "user",
        });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.TryGetProperty("formKey", out _));
        Assert.True(body.TryGetProperty("groupId", out _));
    }

    [Fact]
    public async Task PostPluginRecords_WithTemplate_Returns200()
    {
        var plugin = Uri.EscapeDataString(TestPluginFixture.PluginName);

        var resp = await _client.PostAsJsonAsync($"/plugins/{plugin}/records", new
        {
            recordType = "npc_",
            templateFormKey = _fixture.Npc1FormKey.ToString(),
            source = "user",
        });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.TryGetProperty("formKey", out _));
    }

    [Fact]
    public async Task PostPluginRecords_UnknownRecordType_Returns422()
    {
        var plugin = Uri.EscapeDataString(TestPluginFixture.PluginName);

        var resp = await _client.PostAsJsonAsync($"/plugins/{plugin}/records", new
        {
            recordType = "not_a_real_type",
            source = "user",
        });

        Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
    }

    [Fact]
    public async Task PostPluginRecords_TemplateNotFound_Returns422()
    {
        var plugin = Uri.EscapeDataString(TestPluginFixture.PluginName);

        var resp = await _client.PostAsJsonAsync($"/plugins/{plugin}/records", new
        {
            recordType = "npc_",
            templateFormKey = "FFFFFF:NotReal.esp",
            source = "user",
        });

        Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
    }

    [Fact]
    public async Task CopyRecordTo_ValidRecord_Returns200WithChanges()
    {
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());
        var targetPlugin = Uri.EscapeDataString(TestPluginFixture.PluginName);

        var resp = await _client.PostAsJsonAsync(
            $"/records/{formKey}/copy-to/{targetPlugin}",
            new { });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.ValueKind == JsonValueKind.Array, "Response should be an array of pending changes");
    }
}
