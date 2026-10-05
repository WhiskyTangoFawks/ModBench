using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class IndexRebuildApiTests : HostedTests
{
    [Fact]
    public async Task RebuildingTheIndexOfAnInstance_Is204()
    {
        using var instance = new ScratchDirectory("medit-rebuild-");

        var response = await Client.RebuildIndex(instance.ToString());

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }
}
