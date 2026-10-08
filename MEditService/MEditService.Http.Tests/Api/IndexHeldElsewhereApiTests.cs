using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class IndexHeldElsewhereApiTests : HostedTests
{
    private const string Refusal = "Another window holds the index.";

    protected override MEditHost CreateHost() => new(services => FailingQueries.Replace(services, Refusal));

    [Fact]
    public async Task PostRebuildIndex_WhenAnotherWindowHoldsTheIndex_Is423NamingTheRefusal()
    {
        using var instance = new ScratchDirectory("medit-rebuild-");

        var response = await Client.RebuildIndex(instance.ToString());

        Assert.Equal(HttpStatusCode.Locked, response.StatusCode);
        Assert.Equal(Refusal, (await response.Body()).GetProperty("detail").GetString());
    }
}
