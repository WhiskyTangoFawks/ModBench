using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class OriginRequiredApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    [Theory]
    [InlineData("/plugins/Shared.esp/worldspaces")]
    [InlineData("/plugins/Shared.esp/worldspaces/000800%3AShared.esp/blocks")]
    [InlineData("/plugins/Shared.esp/cells/000800%3AShared.esp/children")]
    [InlineData("/plugins/Shared.esp/interior-cells")]
    [InlineData("/plugins/Shared.esp/records/000800%3AShared.esp/children")]
    public async Task ARouteNamingAPluginWithoutAnOrigin_ReturnsBadRequest(string route)
    {
        var response = await _client.GetAsync(route);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("Origin is required.", (await response.Body()).GetProperty("detail").GetString());
    }
}
