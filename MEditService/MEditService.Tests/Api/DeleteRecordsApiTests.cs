using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

public sealed class DeleteRecordsApiTests(LoadedApiFixture<DeleteRecordsFixture> loaded) : IClassFixture<LoadedApiFixture<DeleteRecordsFixture>>
{
    private readonly HttpClient _client = loaded.Client;
    private readonly DeleteRecordsFixture _fixture = loaded.Plugin;

    private async Task ClearChangesAsync()
    {
        var groups = await _client.GetFromJsonAsync<JsonElement[]>("/change-groups") ?? [];
        foreach (var g in groups)
            await _client.DeleteAsync($"/changes/group/{g.GetProperty("id").GetString()}");
        var changes = await _client.GetFromJsonAsync<JsonElement[]>("/changes") ?? [];
        foreach (var c in changes)
            await _client.DeleteAsync($"/changes/{c.GetProperty("id").GetString()}");
    }

    [Fact]
    public async Task PostDeleteRecords_NoSession_ReturnsProblem()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();

        var resp = await client.PostAsJsonAsync("/records/delete", new
        {
            records = new[] { new { formKey = "000001:Anything.esp", plugin = "Anything.esp" } }
        });

        Assert.NotEqual(HttpStatusCode.OK, resp.StatusCode);
    }

    [Fact]
    public async Task PostDeleteRecords_SingleRecord_Returns200WithChangeGroup()
    {
        await ClearChangesAsync();

        var resp = await _client.PostAsJsonAsync("/records/delete", new
        {
            records = new[] { new { formKey = _fixture.StandaloneNpcFormKey.ToString(), plugin = DeleteRecordsFixture.EditablePlugin } }
        });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        var stagedGroup = body.GetProperty("stagedGroup");
        Assert.True(stagedGroup.TryGetProperty("id", out _), "Response should have a ChangeGroup 'id'");
        Assert.Equal(1, stagedGroup.GetProperty("changeCount").GetInt32());
        Assert.False(body.TryGetProperty("revertedFormKeys", out var reverted) && reverted.ValueKind == JsonValueKind.Array && reverted.GetArrayLength() > 0,
            "A plain committed delete must not report any reverted targets");
    }

    [Fact]
    public async Task PostDeleteRecords_ImmutableRef_Returns409WithBlockedBy()
    {
        var resp = await _client.PostAsJsonAsync("/records/delete", new
        {
            records = new[] { new { formKey = _fixture.Kw1FormKey.ToString(), plugin = DeleteRecordsFixture.EditablePlugin } }
        });

        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.TryGetProperty("blockedBy", out var blocked));
        var refs = blocked.EnumerateArray().ToList();
        Assert.NotEmpty(refs);
        Assert.Equal(_fixture.Kw1FormKey.ToString(), refs[0].GetProperty("targetFormKey").GetString());
        Assert.Equal(DeleteRecordsFixture.ImmutablePlugin, refs[0].GetProperty("sourcePlugin").GetString());
    }

    // #134: deleting a record already pending renumber is blocked with 409 — re-acting on a record
    // whose identity is in flux is incoherent. Previously this test blocked a delete of a
    // *pending-created* record purely because it "had a group"; under ADR-0028 a create does not
    // block a delete (only delete/renumber does), so the scenario is a pending renumber.
    [Fact]
    public async Task PostDeleteRecords_TargetPendingRenumber_Returns409Problem()
    {
        await ClearChangesAsync();

        var rawFormKey = _fixture.EditableNpcFormKey.ToString();
        var renumberResp = await _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(rawFormKey)}/renumber",
            new { newFormId = 0xABC, plugin = DeleteRecordsFixture.EditablePlugin, source = "user" });
        renumberResp.EnsureSuccessStatusCode();

        var resp = await _client.PostAsJsonAsync("/records/delete", new
        {
            records = new[] { new { formKey = rawFormKey, plugin = DeleteRecordsFixture.EditablePlugin } }
        });

        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }

    [Fact]
    public async Task PostDeleteRecords_EditableRef_NullificationStagedAndReturns200()
    {
        await ClearChangesAsync();

        var resp = await _client.PostAsJsonAsync("/records/delete", new
        {
            records = new[] { new { formKey = _fixture.Kw2FormKey.ToString(), plugin = DeleteRecordsFixture.EditablePlugin } }
        });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(2, body.GetProperty("stagedGroup").GetProperty("changeCount").GetInt32());

        var changes = await _client.GetFromJsonAsync<JsonElement[]>(
            $"/changes?formKey={Uri.EscapeDataString(_fixture.EditableNpcFormKey.ToString())}");
        Assert.NotNull(changes);
        Assert.Contains(changes, c =>
            c.GetProperty("changeType").GetString() == "field_edit" &&
            c.GetProperty("fieldPath").GetString() == "keywords");
    }

    // #143: a pending-create target has no on-disk existence for a $delete to act on — deleting it
    // reverts the create's component instead of staging a $delete alongside it.
    [Fact]
    public async Task PostDeleteRecords_TargetPendingCreate_RevertsAndStagesNoDelete()
    {
        await ClearChangesAsync();

        var createResp = await _client.PostAsJsonAsync(
            $"/plugins/{Uri.EscapeDataString(DeleteRecordsFixture.EditablePlugin)}/records",
            new { recordType = "npc_", templateFormKey = (string?)null, source = "user" });
        createResp.EnsureSuccessStatusCode();
        var created = await createResp.Content.ReadFromJsonAsync<JsonElement>();
        var createdFormKey = created.GetProperty("formKey").GetString()!;

        var resp = await _client.PostAsJsonAsync("/records/delete", new
        {
            records = new[] { new { formKey = createdFormKey, plugin = DeleteRecordsFixture.EditablePlugin } }
        });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(body.TryGetProperty("revertedFormKeys", out var formKeys), "Response should have 'revertedFormKeys'");
        Assert.Contains(formKeys.EnumerateArray(), fk => fk.GetString() == createdFormKey);
        Assert.True(
            !body.TryGetProperty("stagedGroup", out var stagedGroup) || stagedGroup.ValueKind == JsonValueKind.Null,
            "Reverted response must not report a staged group — nothing was staged");

        var changes = await _client.GetFromJsonAsync<JsonElement[]>(
            $"/changes?formKey={Uri.EscapeDataString(createdFormKey)}");
        Assert.NotNull(changes);
        Assert.Empty(changes);
    }

    // #143 AC #4, wire-level proof: a batch mixing a pending-create target and a committed target
    // must report both outcomes in the one envelope, never collapsed into just one of them.
    [Fact]
    public async Task PostDeleteRecords_MixedBatch_ReturnsBothStagedGroupAndRevertedFormKeys()
    {
        await ClearChangesAsync();

        var createResp = await _client.PostAsJsonAsync(
            $"/plugins/{Uri.EscapeDataString(DeleteRecordsFixture.EditablePlugin)}/records",
            new { recordType = "npc_", templateFormKey = (string?)null, source = "user" });
        createResp.EnsureSuccessStatusCode();
        var created = await createResp.Content.ReadFromJsonAsync<JsonElement>();
        var createdFormKey = created.GetProperty("formKey").GetString()!;

        var resp = await _client.PostAsJsonAsync("/records/delete", new
        {
            records = new[]
            {
                new { formKey = createdFormKey, plugin = DeleteRecordsFixture.EditablePlugin },
                new { formKey = _fixture.StandaloneNpc2FormKey.ToString(), plugin = DeleteRecordsFixture.EditablePlugin },
            }
        });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();

        Assert.True(body.TryGetProperty("revertedFormKeys", out var reverted), "Response should have 'revertedFormKeys'");
        Assert.Contains(reverted.EnumerateArray(), fk => fk.GetString() == createdFormKey);

        Assert.True(body.TryGetProperty("stagedGroup", out var stagedGroup), "Response should have 'stagedGroup'");
        Assert.NotEqual(JsonValueKind.Null, stagedGroup.ValueKind);
        Assert.Equal(1, stagedGroup.GetProperty("changeCount").GetInt32());

        var changes = await _client.GetFromJsonAsync<JsonElement[]>(
            $"/changes?formKey={Uri.EscapeDataString(_fixture.StandaloneNpc2FormKey.ToString())}");
        Assert.NotNull(changes);
        Assert.Contains(changes, c => c.GetProperty("changeType").GetString() == "delete");

        var createdChanges = await _client.GetFromJsonAsync<JsonElement[]>(
            $"/changes?formKey={Uri.EscapeDataString(createdFormKey)}");
        Assert.NotNull(createdChanges);
        Assert.Empty(createdChanges);
    }

    [Fact]
    public async Task PostDeleteRecords_NullRecordsBody_Returns400()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();

        var resp = await client.PostAsJsonAsync("/records/delete", new { });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    // Changed by ADR-0028 — not a regression. The response used to describe a single group of two,
    // because the call labelled both deletes with one group_id. These two NPCs are standalone: they
    // reference nothing of each other's, so nothing entangles them and reverting one cannot
    // invalidate the other. The response now describes the component the first delete landed in — a
    // group of one — and the batch surfaces as two independently revertable groups.
    [Fact]
    public async Task PostDeleteRecords_BatchTwoIndependentRecords_AreSeparateGroups()
    {
        await ClearChangesAsync();

        var resp = await _client.PostAsJsonAsync("/records/delete", new
        {
            records = new[]
            {
                new { formKey = _fixture.StandaloneNpcFormKey.ToString(), plugin = DeleteRecordsFixture.EditablePlugin },
                new { formKey = _fixture.StandaloneNpc2FormKey.ToString(), plugin = DeleteRecordsFixture.EditablePlugin },
            }
        });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1, body.GetProperty("stagedGroup").GetProperty("changeCount").GetInt32());

        var groups = await _client.GetFromJsonAsync<JsonElement[]>("/change-groups") ?? [];
        Assert.Equal(2, groups.Length);
        Assert.All(groups, g => Assert.Equal("delete", g.GetProperty("operation").GetString()));
    }
}
