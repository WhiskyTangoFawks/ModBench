using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class IndexRebuildApiTests : HostedTests
{
    [Fact]
    public async Task RebuildingTheIndexOfAnInstance_Is204()
    {
        using var instance = new ScratchDirectory("medit-rebuild-");

        var response = await Client.PostAsJsonAsync(
            "/index/rebuild", new { instanceRoot = instance.ToString(), gameRelease = "Fallout4" });

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }
}
