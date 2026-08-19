using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

public sealed class ReferenceApiTests(LoadedApiFixture<ReferencePluginFixture> loaded) : IClassFixture<LoadedApiFixture<ReferencePluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;
    private readonly ReferencePluginFixture _fixture = loaded.Plugin;

    // --- Committed references ---

    [Fact]
    public async Task GetReferences_CommittedReferenceExists_ReturnsNpcThatReferencesKeyword()
    {
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
}
