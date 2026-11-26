using System.Net;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

[Collection(LoadedApiCollection.Name)]
public sealed class WebPageRefusalApiTests(LoadedApiFixture<TestPluginFixture> loaded)
{
    [Theory]
    [InlineData("http://localhost:3000", HttpStatusCode.Forbidden)]
    [InlineData("http://localhost", HttpStatusCode.OK)]
    public async Task ARequestCarryingAnOrigin_IsServedOnlyWhenItIsTheServicesOwn(string origin, HttpStatusCode expected)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/health");
        request.Headers.Add("Origin", origin);

        var response = await loaded.Client.SendAsync(request);

        Assert.Equal(expected, response.StatusCode);
    }

    [Fact]
    public async Task ARequestToAHostThatIsNotLoopback_IsRefused()
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/health");
        request.Headers.Host = "rebound.example:5172";

        var response = await loaded.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
