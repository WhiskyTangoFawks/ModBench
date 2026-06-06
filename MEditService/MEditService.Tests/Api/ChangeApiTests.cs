using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

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
