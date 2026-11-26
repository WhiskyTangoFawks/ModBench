using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

[Collection(LoadedApiCollection.Name)]
public sealed class ReferenceApiTests(LoadedApiFixture<TestPluginFixture> loaded)
{
    private readonly HttpClient _client = loaded.Client;

    [Theory]
    [InlineData("FFFFFF:Unknown.esp")]
    [InlineData("not-a-formkey")]
    public async Task GetReferences_UnresolvableFormKey_Returns200WithEmptyArray(string rawFormKey)
    {
        var encoded = Uri.EscapeDataString(rawFormKey);

        var resp = await _client.GetAsync($"/records/{encoded}/references-in-active-or-compiled-plugins");

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var results = await resp.Content.ReadFromJsonAsync<JsonElement[]>();
        Assert.NotNull(results);
        Assert.Empty(results);
    }

    [Fact]
    public async Task GetPlacedReferences_UnreferencedFormKey_Returns200PlacingNone()
    {
        var resp = await _client.GetAsync($"/records/{Uri.EscapeDataString("FFFFFF:Unknown.esp")}/placed-references");

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var placed = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(placed.GetProperty("copies").EnumerateArray());
        Assert.Empty(placed.GetProperty("leftOut").EnumerateArray());
    }
}
