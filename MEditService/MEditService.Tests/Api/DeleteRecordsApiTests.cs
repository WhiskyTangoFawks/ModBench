using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

[Collection("ApiTests")]
public sealed class DeleteRecordsApiTests : IClassFixture<DeleteRecordsFixture>
{
    private readonly DeleteRecordsFixture _fixture;
    private readonly WebApplicationFactory<Program> _app;

    public DeleteRecordsApiTests(DeleteRecordsFixture fixture, ApiWebAppFixture webApp)
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
    public async Task PostDeleteRecords_NoSession_ReturnsProblem()
    {
        // Fresh isolated app — no session loaded
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
        var client = await LoadedClient();

        var resp = await client.PostAsJsonAsync("/records/delete", new
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
        var client = await LoadedClient();

        // Kw1 is referenced by Fallout4.esm's NPC — must be blocked
        var resp = await client.PostAsJsonAsync("/records/delete", new
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
        var client = await LoadedClient();

        // Stage a create-group on Editable.esp
        var createResp = await client.PostAsJsonAsync(
            $"/plugins/{Uri.EscapeDataString(DeleteRecordsFixture.EditablePlugin)}/records",
            new { recordType = "npc_", source = "user" });
        createResp.EnsureSuccessStatusCode();
        var created = await createResp.Content.ReadFromJsonAsync<JsonElement>();
        var newFormKey = created.GetProperty("formKey").GetString()!;

        // Deleting the just-created record should be blocked by its pending group
        var resp = await client.PostAsJsonAsync("/records/delete", new
        {
            records = new[] { new { formKey = newFormKey, plugin = DeleteRecordsFixture.EditablePlugin } }
        });

        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }

    [Fact]
    public async Task PostDeleteRecords_EditableRef_NullificationStagedAndReturns200()
    {
        var client = await LoadedClient();

        // Kw2 is only referenced by EditableNpc (editable) — delete succeeds with nullification
        var resp = await client.PostAsJsonAsync("/records/delete", new
        {
            records = new[] { new { formKey = _fixture.Kw2FormKey.ToString(), plugin = DeleteRecordsFixture.EditablePlugin } }
        });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        // changeCount = 1 delete + 1 nullification
        Assert.Equal(2, body.GetProperty("changeCount").GetInt32());

        // Verify the nullification change is staged
        var changes = await client.GetFromJsonAsync<JsonElement[]>(
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
        var client = await LoadedClient();

        var resp = await client.PostAsJsonAsync("/records/delete", new
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
