using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

public sealed class DeleteRecordsApiTests(LoadedDeleteRecordsApiFixture loaded) : IClassFixture<LoadedDeleteRecordsApiFixture>
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
        Assert.True(body.TryGetProperty("id", out _), "Response should have a ChangeGroup 'id'");
        Assert.True(body.TryGetProperty("changeCount", out var countEl), "Response should have 'changeCount'");
        Assert.Equal(1, countEl.GetInt32());
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

    [Fact]
    public async Task PostDeleteRecords_PendingGroupBlock_Returns409Problem()
    {
        await ClearChangesAsync();

        var createResp = await _client.PostAsJsonAsync(
            $"/plugins/{Uri.EscapeDataString(DeleteRecordsFixture.EditablePlugin)}/records",
            new { recordType = "npc_", source = "user" });
        createResp.EnsureSuccessStatusCode();
        var created = await createResp.Content.ReadFromJsonAsync<JsonElement>();
        var newFormKey = created.GetProperty("formKey").GetString()!;

        var resp = await _client.PostAsJsonAsync("/records/delete", new
        {
            records = new[] { new { formKey = newFormKey, plugin = DeleteRecordsFixture.EditablePlugin } }
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
        Assert.Equal(2, body.GetProperty("changeCount").GetInt32());

        var changes = await _client.GetFromJsonAsync<JsonElement[]>(
            $"/changes?formKey={Uri.EscapeDataString(_fixture.EditableNpcFormKey.ToString())}");
        Assert.NotNull(changes);
        Assert.Contains(changes, c =>
            c.GetProperty("changeType").GetString() == "field_edit" &&
            c.GetProperty("fieldPath").GetString() == "keywords");
    }

    [Fact]
    public async Task PostDeleteRecords_NullRecordsBody_Returns400()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();

        var resp = await client.PostAsJsonAsync("/records/delete", new { });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task PostDeleteRecords_BatchTwoRecords_SingleGroupInResponse()
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
        Assert.Equal(2, body.GetProperty("changeCount").GetInt32());
    }
}
