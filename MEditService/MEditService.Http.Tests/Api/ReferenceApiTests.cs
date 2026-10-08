using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class ReferenceApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    [Theory]
    [InlineData("FFFFFF:Unknown.esp", "references")]
    [InlineData("not-a-formkey", "references")]
    [InlineData("FFFFFF:Unknown.esp", "references-in-active-or-tracked-plugins")]
    [InlineData("not-a-formkey", "references-in-active-or-tracked-plugins")]
    public async Task GetReferences_UnresolvableFormKey_Returns200WithEmptyArray(string rawFormKey, string route)
    {
        var encoded = Uri.EscapeDataString(rawFormKey);

        var resp = await _client.GetAsync($"/records/{encoded}/{route}");

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var results = await resp.Content.ReadFromJsonAsync<JsonElement[]>();
        Assert.NotNull(results);
        Assert.Empty(results);
    }
}
