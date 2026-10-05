using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class IndexHeldElsewhereApiTests : HostedTests
{
    private const string Refusal = "Another window holds the index.";

    protected override MEditHost CreateHost() => new(services => UnreachableIndex.Replace(services, Refusal));

    [Fact]
    public async Task PostRebuildIndex_WhenAnotherWindowHoldsTheIndex_Is423NamingTheRefusal()
    {
        using var instance = new ScratchDirectory("medit-rebuild-");

        var response = await Client.PostAsJsonAsync(
            "/index/rebuild", new { instanceRoot = instance.ToString(), gameRelease = "Fallout4" });

        Assert.Equal(HttpStatusCode.Locked, response.StatusCode);
        Assert.Equal(Refusal, (await response.Body()).GetProperty("detail").GetString());
    }
}
