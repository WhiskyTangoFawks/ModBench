using System.Net;
using MEditService.Http.Tests.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class WebPageRefusalApiTests
{
    [Theory]
    [InlineData("GET", "http://evil.example")]
    [InlineData("POST", "http://evil.example")]
    [InlineData("PUT", "http://localhost:3000")]
    [InlineData("POST", "null")]
    public async Task ARequestCarryingAnotherOrigin_IsRefused(string method, string origin)
    {
        await using var app = new MEditHost();
        using var request = new HttpRequestMessage(new HttpMethod(method), "/health");
        request.Headers.Add("Origin", origin);

        var response = await app.CreateClient().SendAsync(request);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task ARequestFromTheSwaggerPage_CarryingItsOwnOrigin_IsServed()
    {
        await using var app = new MEditHost();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/health");
        request.Headers.Add("Origin", "http://localhost");

        var response = await app.CreateClient().SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task ARequestWithNoOrigin_IsServed()
    {
        await using var app = new MEditHost();

        var response = await app.CreateClient().GetAsync("/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task ARequestToAHostThatIsNotLoopback_IsRefused()
    {
        await using var app = new MEditHost();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/health");
        request.Headers.Host = "rebound.example:5172";

        var response = await app.CreateClient().SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task APreflight_IsNotAnsweredWithAnAllowance()
    {
        await using var app = new MEditHost();
        using var request = new HttpRequestMessage(HttpMethod.Options, "/health");
        request.Headers.Add("Origin", "http://localhost");
        request.Headers.Add("Access-Control-Request-Method", "POST");

        var response = await app.CreateClient().SendAsync(request);

        Assert.False(response.Headers.Contains("Access-Control-Allow-Origin"));
    }
}
