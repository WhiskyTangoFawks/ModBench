using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

[Collection("ApiTests")]
public sealed class ChangeApiTests : IClassFixture<TestPluginFixture>
{
    private readonly TestPluginFixture _fixture;

    public ChangeApiTests(TestPluginFixture fixture) => _fixture = fixture;

    private async Task<HttpClient> LoadedClient(WebApplicationFactory<Program> app)
    {
        var client = app.CreateClient();
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
        await using var app = new WebApplicationFactory<Program>();
        var client  = await LoadedClient(app);
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
        await using var app = new WebApplicationFactory<Program>();
        var client  = await LoadedClient(app);
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
        await using var app = new WebApplicationFactory<Program>();
        var client  = await LoadedClient(app);
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
        await using var app = new WebApplicationFactory<Program>();
        var client  = await LoadedClient(app);
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
        await using var app = new WebApplicationFactory<Program>();
        var client      = await LoadedClient(app);
        var rawFormKey  = _fixture.Npc1FormKey.ToString();
        var formKey     = Uri.EscapeDataString(rawFormKey);

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
    public async Task Compare_AfterPatch_IncludesPendingFields()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client  = await LoadedClient(app);
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        await client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        var compareJson = await client.GetStringAsync($"/records/{formKey}/compare");
        var compare     = JsonSerializer.Deserialize<JsonElement>(compareJson);
        var overrides   = compare.GetProperty("overrides");

        var hasPendingFields = false;
        foreach (var ov in overrides.EnumerateArray())
        {
            if (ov.TryGetProperty("pendingFields", out var pf) && pf.ValueKind != JsonValueKind.Null)
                hasPendingFields = true;
        }
        Assert.True(hasPendingFields);
    }

    [Fact]
    public async Task Save_AfterPatch_Returns200WithBackupPath()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client  = await LoadedClient(app);
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        await client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });

        var saveResp = await client.PostAsync(
            $"/plugins/{Uri.EscapeDataString(TestPluginFixture.PluginName)}/save", null);
        Assert.Equal(HttpStatusCode.OK, saveResp.StatusCode);

        var body       = JsonSerializer.Deserialize<JsonElement>(await saveResp.Content.ReadAsStringAsync());
        var backupPath = body.GetProperty("backupPath").GetString();
        Assert.NotNull(backupPath);
        Assert.True(File.Exists(backupPath));

        var afterChanges = await client.GetFromJsonAsync<JsonElement[]>("/changes");
        Assert.Empty(afterChanges!);
    }
}
