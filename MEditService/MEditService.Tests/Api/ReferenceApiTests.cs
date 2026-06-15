using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

public sealed class ReferenceApiTests : IClassFixture<LoadedReferenceApiFixture>
{
    private readonly HttpClient _client;
    private readonly ReferencePluginFixture _fixture;

    public ReferenceApiTests(LoadedReferenceApiFixture loaded)
    {
        _client = loaded.Client;
        _fixture = loaded.Plugin;
    }

    private async Task ClearChangesAsync()
    {
        var groups = await _client.GetFromJsonAsync<JsonElement[]>("/change-groups") ?? [];
        foreach (var g in groups)
            await _client.DeleteAsync($"/changes/group/{g.GetProperty("id").GetString()}");
        var changes = await _client.GetFromJsonAsync<JsonElement[]>("/changes") ?? [];
        foreach (var c in changes)
            await _client.DeleteAsync($"/changes/{c.GetProperty("id").GetString()}");
    }

    // --- Committed references ---

    [Fact]
    public async Task GetReferences_CommittedReferenceExists_ReturnsNpcThatReferencesKeyword()
    {
        await ClearChangesAsync();
        var kwKey = Uri.EscapeDataString(_fixture.KeywordFormKey.ToString());

        var resp = await _client.GetAsync($"/records/{kwKey}/references");

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
        var encoded = Uri.EscapeDataString(rawFormKey);

        var resp = await _client.GetAsync($"/records/{encoded}/references");

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var results = await resp.Content.ReadFromJsonAsync<JsonElement[]>();
        Assert.NotNull(results);
        Assert.Empty(results);
    }

    // --- Pending changes ---

    [Fact]
    public async Task GetReferences_PendingAddition_AppearsInResults()
    {
        await ClearChangesAsync();
        var kwKey = Uri.EscapeDataString(_fixture.KeywordFormKey.ToString());
        var npcKey = Uri.EscapeDataString(_fixture.NpcWithoutKeywordFormKey.ToString());

        var patch = await _client.PatchAsJsonAsync($"/records/{npcKey}", new
        {
            plugin = ReferencePluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["keywords"] = new[] { _fixture.KeywordFormKey.ToString() } },
            source = "user",
        });
        patch.EnsureSuccessStatusCode();

        var resp = await _client.GetAsync($"/records/{kwKey}/references");
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
        await ClearChangesAsync();
        var kwKey = Uri.EscapeDataString(_fixture.KeywordFormKey.ToString());
        var npcKey = Uri.EscapeDataString(_fixture.NpcWithKeywordFormKey.ToString());

        var patch = await _client.PatchAsJsonAsync($"/records/{npcKey}", new
        {
            plugin = ReferencePluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["keywords"] = Array.Empty<string>() },
            source = "user",
        });
        patch.EnsureSuccessStatusCode();

        var resp = await _client.GetAsync($"/records/{kwKey}/references");
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
        await ClearChangesAsync();
        var kwKey = Uri.EscapeDataString(_fixture.KeywordFormKey.ToString());
        var npcKey = Uri.EscapeDataString(_fixture.NpcWithKeywordFormKey.ToString());

        var patch = await _client.PatchAsJsonAsync($"/records/{npcKey}", new
        {
            plugin = ReferencePluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["aggression"] = "Frenzied" },
            source = "user",
        });
        patch.EnsureSuccessStatusCode();

        var resp = await _client.GetAsync($"/records/{kwKey}/references");
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
        await ClearChangesAsync();
        var kwKey = Uri.EscapeDataString(_fixture.KeywordFormKey.ToString());
        var npcKey = Uri.EscapeDataString(_fixture.NpcWithoutKeywordFormKey.ToString());

        var patch = await _client.PatchAsJsonAsync($"/records/{npcKey}", new
        {
            plugin = ReferencePluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["keywords"] = new[] { _fixture.KeywordFormKey.ToString() } },
            source = "user",
        });
        patch.EnsureSuccessStatusCode();

        var resp = await _client.GetAsync($"/records/{kwKey}/references");
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
        await ClearChangesAsync();
        var kwKey = Uri.EscapeDataString(_fixture.KeywordFormKey.ToString());
        var npcKey = Uri.EscapeDataString(_fixture.NpcWithoutKeywordFormKey.ToString());

        var patch = await _client.PatchAsJsonAsync($"/records/{npcKey}", new
        {
            plugin = ReferencePluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["name"] = _fixture.KeywordFormKey.ToString() },
            source = "user",
        });
        patch.EnsureSuccessStatusCode();

        var resp = await _client.GetAsync($"/records/{kwKey}/references");
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
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();
        var resp = await client.GetAsync("/records/000001:Anything.esp/references");
        Assert.NotEqual(HttpStatusCode.OK, resp.StatusCode);
    }
}
