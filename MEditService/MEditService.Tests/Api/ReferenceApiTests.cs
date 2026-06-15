using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

[Collection("ApiTests")]
public sealed class ReferenceApiTests : IClassFixture<ReferencePluginFixture>
{
    private readonly ReferencePluginFixture _fixture;
    private readonly WebApplicationFactory<Program> _app;

    public ReferenceApiTests(ReferencePluginFixture fixture, ApiWebAppFixture webApp)
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

    // --- Committed references ---

    [Fact]
    public async Task GetReferences_CommittedReferenceExists_ReturnsNpcThatReferencesKeyword()
    {
        var client = await LoadedClient();
        var kwKey = Uri.EscapeDataString(_fixture.KeywordFormKey.ToString());

        var resp = await client.GetAsync($"/records/{kwKey}/references");

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var results = await resp.Content.ReadFromJsonAsync<JsonElement[]>();
        Assert.NotNull(results);

        var match = results.FirstOrDefault(r =>
            r.GetProperty("formKey").GetString() == _fixture.NpcWithKeywordFormKey.ToString() &&
            r.GetProperty("plugin").GetString() == ReferencePluginFixture.PluginName);
        Assert.NotEqual(default, match);
        Assert.Equal("TestNPC_WithKw", match.GetProperty("editorId").GetString());
    }

    [Theory]
    [InlineData("FFFFFF:Unknown.esp")]
    [InlineData("not-a-formkey")]
    public async Task GetReferences_UnresolvableFormKey_Returns200WithEmptyArray(string rawFormKey)
    {
        var client = await LoadedClient();
        var encoded = Uri.EscapeDataString(rawFormKey);

        var resp = await client.GetAsync($"/records/{encoded}/references");

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var results = await resp.Content.ReadFromJsonAsync<JsonElement[]>();
        Assert.NotNull(results);
        Assert.Empty(results);
    }

    // --- Pending changes ---

    [Fact]
    public async Task GetReferences_PendingAddition_AppearsInResults()
    {
        var client = await LoadedClient();
        var kwKey = Uri.EscapeDataString(_fixture.KeywordFormKey.ToString());
        var npcKey = Uri.EscapeDataString(_fixture.NpcWithoutKeywordFormKey.ToString());

        var patch = await client.PatchAsJsonAsync($"/records/{npcKey}", new
        {
            plugin = ReferencePluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["keywords"] = new[] { _fixture.KeywordFormKey.ToString() } },
            source = "user",
        });
        patch.EnsureSuccessStatusCode();

        var resp = await client.GetAsync($"/records/{kwKey}/references");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var results = await resp.Content.ReadFromJsonAsync<JsonElement[]>();
        Assert.NotNull(results);

        var added = results.FirstOrDefault(r =>
            r.GetProperty("formKey").GetString() == _fixture.NpcWithoutKeywordFormKey.ToString() &&
            r.GetProperty("plugin").GetString() == ReferencePluginFixture.PluginName);
        Assert.NotEqual(default, added);
    }

    [Fact]
    public async Task GetReferences_PendingRemoval_DisappearsFromResults()
    {
        var client = await LoadedClient();
        var kwKey = Uri.EscapeDataString(_fixture.KeywordFormKey.ToString());
        var npcKey = Uri.EscapeDataString(_fixture.NpcWithKeywordFormKey.ToString());

        // Replace keyword list with an empty array — the committed reference disappears
        var patch = await client.PatchAsJsonAsync($"/records/{npcKey}", new
        {
            plugin = ReferencePluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["keywords"] = Array.Empty<string>() },
            source = "user",
        });
        patch.EnsureSuccessStatusCode();

        var resp = await client.GetAsync($"/records/{kwKey}/references");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var results = await resp.Content.ReadFromJsonAsync<JsonElement[]>();
        Assert.NotNull(results);

        var stillPresent = results.Any(r =>
            r.GetProperty("formKey").GetString() == _fixture.NpcWithKeywordFormKey.ToString() &&
            r.GetProperty("plugin").GetString() == ReferencePluginFixture.PluginName);
        Assert.False(stillPresent, "NPC with keywords cleared should not appear in references.");
    }

    [Fact]
    public async Task GetReferences_UnrelatedPendingChange_CommittedReferenceStillAppears()
    {
        var client = await LoadedClient();
        var kwKey = Uri.EscapeDataString(_fixture.KeywordFormKey.ToString());
        var npcKey = Uri.EscapeDataString(_fixture.NpcWithKeywordFormKey.ToString());

        // Patch an unrelated field (aggression) — keyword reference must still show up
        var patch = await client.PatchAsJsonAsync($"/records/{npcKey}", new
        {
            plugin = ReferencePluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });
        patch.EnsureSuccessStatusCode();

        var resp = await client.GetAsync($"/records/{kwKey}/references");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var results = await resp.Content.ReadFromJsonAsync<JsonElement[]>();
        Assert.NotNull(results);

        var match = results.FirstOrDefault(r =>
            r.GetProperty("formKey").GetString() == _fixture.NpcWithKeywordFormKey.ToString() &&
            r.GetProperty("plugin").GetString() == ReferencePluginFixture.PluginName);
        Assert.NotEqual(default, match);
    }

    [Fact]
    public async Task GetReferences_PendingAddition_ReturnsElementLevelFieldPath()
    {
        var client = await LoadedClient();
        var kwKey = Uri.EscapeDataString(_fixture.KeywordFormKey.ToString());
        var npcKey = Uri.EscapeDataString(_fixture.NpcWithoutKeywordFormKey.ToString());

        var patch = await client.PatchAsJsonAsync($"/records/{npcKey}", new
        {
            plugin = ReferencePluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["keywords"] = new[] { _fixture.KeywordFormKey.ToString() } },
            source = "user",
        });
        patch.EnsureSuccessStatusCode();

        var resp = await client.GetAsync($"/records/{kwKey}/references");
        var results = await resp.Content.ReadFromJsonAsync<JsonElement[]>();
        Assert.NotNull(results);

        var added = results.FirstOrDefault(r =>
            r.GetProperty("formKey").GetString() == _fixture.NpcWithoutKeywordFormKey.ToString() &&
            r.GetProperty("plugin").GetString() == ReferencePluginFixture.PluginName);
        Assert.NotEqual(default, added);
        // TD-2: must return per-element path, not column-level "keywords"
        Assert.Equal("keywords[0]", added.GetProperty("fieldPath").GetString());
    }

    [Fact]
    public async Task GetReferences_PendingFreeTextField_DoesNotProduceFalsePositive()
    {
        var client = await LoadedClient();
        var kwKey = Uri.EscapeDataString(_fixture.KeywordFormKey.ToString());
        var npcKey = Uri.EscapeDataString(_fixture.NpcWithoutKeywordFormKey.ToString());

        // Stage a free-text field whose value happens to contain the FormKey string verbatim.
        // With a LIKE-based scan this would be a false positive; with pending_form_references it must not be.
        var patch = await client.PatchAsJsonAsync($"/records/{npcKey}", new
        {
            plugin = ReferencePluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["name"] = _fixture.KeywordFormKey.ToString() },
            source = "user",
        });
        patch.EnsureSuccessStatusCode();

        var resp = await client.GetAsync($"/records/{kwKey}/references");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var results = await resp.Content.ReadFromJsonAsync<JsonElement[]>();
        Assert.NotNull(results);

        var falsePositive = results.Any(r =>
            r.GetProperty("formKey").GetString() == _fixture.NpcWithoutKeywordFormKey.ToString());
        Assert.False(falsePositive, "A staged free-text field containing a FormKey string must not appear as a reference.");
    }

    [Fact]
    public async Task GetReferences_NoSessionLoaded_ReturnsProblem()
    {
        // Fresh isolated app — no session loaded
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();
        var resp = await client.GetAsync("/records/000001:Anything.esp/references");
        Assert.NotEqual(HttpStatusCode.OK, resp.StatusCode);
    }
}
