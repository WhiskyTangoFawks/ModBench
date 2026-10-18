using System.Net;
using MEditService.Http.Tests.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class WebPageRefusalApiTests : HostedTests
{
    [Theory]
    [InlineData("GET", "http://evil.example", HttpStatusCode.Forbidden)]
    [InlineData("POST", "http://evil.example", HttpStatusCode.Forbidden)]
    [InlineData("PUT", "http://localhost:3000", HttpStatusCode.Forbidden)]
    [InlineData("POST", "null", HttpStatusCode.Forbidden)]
    [InlineData("GET", "http://localhost", HttpStatusCode.OK)]
    public async Task ARequestCarryingAnOrigin_IsServedOnlyWhenItIsTheServicesOwn(string method, string origin, HttpStatusCode expected)
    {
        using var request = new HttpRequestMessage(new HttpMethod(method), "/health");
        request.Headers.Add("Origin", origin);

        var response = await Client.SendAsync(request);

        Assert.Equal(expected, response.StatusCode);
    }

    [Fact]
    public async Task ARequestToAHostThatIsNotLoopback_IsRefused()
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/health");
        request.Headers.Host = "rebound.example:5172";

        var response = await Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
