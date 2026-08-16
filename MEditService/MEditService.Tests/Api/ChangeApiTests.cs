using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Core.Edits;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Tests.Api;

public sealed class ChangeApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;
    private readonly TestPluginFixture _fixture = loaded.Plugin;
    private readonly IServiceProvider _services = loaded.Services;

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
            JsonDocument.Parse("\"x\"").RootElement.Clone(),
            "system", null, null, "Data");

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

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

    // #296: GetChanges_FilteredByPlugin_ReturnsMatchingOnly removed with the `plugin` query
    // parameter it exercised — its only reference was this test asserting the filter for its own
    // sake; no caller (frontend, MCP, or otherwise) ever used it. See IRecordQueryService.GetChanges.

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

    // A group spans plugins when a dependency does. Two unrelated creates in two plugins used to
    // count as one group of two plugins purely because one StageGroup call labelled them; under
    // ADR-0028 they are two groups of one. So the cross-plugin group here is a real one: B.esp's
    // edit holds a FormLink to a record only A.esp's pending $create brings into existence.
    [Fact]
    public async Task GetChangeGroups_ReturnsPluginCount()
    {
        await ClearChangesAsync();
        var svc = GetService();
        svc.Upsert(new PendingChangeUpsert("FK-PC1", "A.esp", "npc_",
            new Dictionary<string, JsonElement> { ["$create"] = J("null") },
            "user", null, [], FormRefs: null, ChangeType: "create", ParentCell: null, PlacementGroup: null, Origin: "Data"));
        svc.Upsert(new PendingChangeUpsert("FK-PC2", "B.esp", "npc_",
            new Dictionary<string, JsonElement> { ["leader"] = J("\"FK-PC1\"") },
            "user", null,
            new Dictionary<string, JsonElement> { ["leader"] = J("null") },
            [new PendingFormRef("leader", "leader", "FK-PC1")], ChangeType: PendingChangeConstants.FieldEditChangeType, ParentCell: null, PlacementGroup: null, Origin: "Data"));

        var groups = await _client.GetFromJsonAsync<JsonElement[]>("/change-groups");
        Assert.NotNull(groups);
        var group = Assert.Single(groups);
        Assert.Equal(2, group.GetProperty("pluginCount").GetInt32());
        Assert.Equal(2, group.GetProperty("changeCount").GetInt32());
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
        // Both changes are on the one record FK-G1's $create brings into existence, so they are one
        // component (edge rule 2). Two changes on *different* records would be two groups now.
        var members = new[] { ApiMember("FK-G1", "Test.esp", "name"), ApiMember("FK-G1", "Test.esp", "level") };
        var group = svc.StageChanges(members);

        var del = await _client.DeleteAsync($"/changes/group/{group.Id}");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        var changes = await _client.GetFromJsonAsync<JsonElement[]>($"/changes?groupId={group.Id}");
        Assert.Empty(changes!);
        var groups = await _client.GetFromJsonAsync<JsonElement[]>("/change-groups");
        Assert.Empty(groups!);
    }

    // ADR-0028 supersedes ADR-0017 §4: 409 when the change's *component* has more than one member,
    // not whenever it carries a group_id. So this needs two entangled changes to be refused — a lone
    // one is now a group of one and reverts freely (DeleteChange_SoleMemberOfComponent_Returns204).
    [Fact]
    public async Task DeleteChange_GroupOwned_Returns409WithGroupIdInDetail()
    {
        await ClearChangesAsync();
        var svc = GetService();
        var members = new[] { ApiMember("FK-GO", "Test.esp", "name"), ApiMember("FK-GO", "Test.esp", "level") };
        var group = svc.StageChanges(members);
        var changeId = svc.GetChanges(formKey: "FK-GO")[0].Id;

        var resp = await _client.DeleteAsync($"/changes/{changeId}");

        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
        var body = JsonDocument.Parse(await resp.Content.ReadAsStringAsync()).RootElement;
        Assert.Contains(group.Id.ToString(), body.GetProperty("detail").GetString()!);
    }

    // The other half of the rule, and the shape of the #112 fix at the HTTP edge: an ordinary field
    // edit is entangled with nothing, so it reverts on its own rather than 409-ing forever.
    [Fact]
    public async Task DeleteChange_SoleMemberOfComponent_Returns204()
    {
        await ClearChangesAsync();
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());
        await _client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });
        var changeId = GetService().GetChanges(formKey: _fixture.Npc1FormKey.ToString())[0].Id;

        var resp = await _client.DeleteAsync($"/changes/{changeId}");

        Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
        Assert.Empty(await _client.GetFromJsonAsync<JsonElement[]>("/changes") ?? []);
    }

    // #134: editing a record pending delete is blocked at the endpoint with a 409 that names the
    // blocking op (delete) — keyed on the lifecycle change, not on "has a group."
    [Fact]
    public async Task Patch_RecordPendingDelete_Returns409NamingTheOp()
    {
        await ClearChangesAsync();
        var rawFormKey = _fixture.Npc1FormKey.ToString();

        var delResp = await _client.PostAsJsonAsync("/records/delete", new
        {
            records = new[] { new { formKey = rawFormKey, plugin = TestPluginFixture.PluginName } },
        });
        Assert.Equal(HttpStatusCode.OK, delResp.StatusCode);

        var resp = await _client.PatchAsJsonAsync($"/records/{Uri.EscapeDataString(rawFormKey)}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
        var body = JsonDocument.Parse(await resp.Content.ReadAsStringAsync()).RootElement;
        Assert.Contains("delete", body.GetProperty("detail").GetString()!, StringComparison.OrdinalIgnoreCase);
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

    // #281: Copy as New Record from a tree row supplies only the FormKey — recordType is derived
    // from the template server-side, so the request may omit it.
    [Fact]
    public async Task PostPluginRecords_TemplateWithoutRecordType_Returns200()
    {
        var plugin = Uri.EscapeDataString(TestPluginFixture.PluginName);

        var resp = await _client.PostAsJsonAsync($"/plugins/{plugin}/records", new
        {
            templateFormKey = _fixture.Npc1FormKey.ToString(),
            source = "user",
        });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.TryGetProperty("formKey", out _));
    }

    // #281: templateSourcePlugin binds and threads — a source with no loaded copy of the template
    // record must fail the template lookup (422), where an unbound field would fall through to the
    // winner and answer 200.
    [Fact]
    public async Task PostPluginRecords_TemplateSourcePluginNotLoaded_Returns422()
    {
        var plugin = Uri.EscapeDataString(TestPluginFixture.PluginName);

        var resp = await _client.PostAsJsonAsync($"/plugins/{plugin}/records", new
        {
            templateFormKey = _fixture.Npc1FormKey.ToString(),
            templateSourcePlugin = "NotLoaded.esp",
            source = "user",
        });

        Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
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

    // Issue #202: SourcePlugin in the request body must reach the orchestrator — a thin
    // pass-through, proven both ways: an explicit, valid source plugin still stages (200), and an
    // explicit plugin with no override of this record surfaces as RecordNotFound (404), which a
    // default (winner-only) copy of an existing record would never hit.
    [Fact]
    public async Task CopyRecordTo_ExplicitSourcePlugin_Returns200WithChanges()
    {
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());
        var targetPlugin = Uri.EscapeDataString(TestPluginFixture.PluginName);

        var resp = await _client.PostAsJsonAsync(
            $"/records/{formKey}/copy-to/{targetPlugin}",
            new { sourcePlugin = TestPluginFixture.PluginName });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.ValueKind == JsonValueKind.Array, "Response should be an array of pending changes");
    }

    [Fact]
    public async Task CopyRecordTo_ExplicitSourcePluginNotOverridden_Returns404()
    {
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());
        var targetPlugin = Uri.EscapeDataString(TestPluginFixture.PluginName);

        var resp = await _client.PostAsJsonAsync(
            $"/records/{formKey}/copy-to/{targetPlugin}",
            new { sourcePlugin = "NoOverride.esp" });

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }
}
