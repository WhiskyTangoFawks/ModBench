using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class IndexRebuildInstanceRootApiTests : HostedTests
{
    private Task<HttpResponseMessage> Rebuild(string instanceRoot) =>
        Client.PostAsJsonAsync("/index/rebuild", new { instanceRoot, gameRelease = "Fallout4" });

    [Fact]
    public async Task RebuildingAnInstanceRootThatIsNotThere_Is400()
    {
        var rebuilt = await Rebuild(Path.Combine(Path.GetTempPath(), $"no-such-instance-{Guid.NewGuid():N}"));

        Assert.Equal(HttpStatusCode.BadRequest, rebuilt.StatusCode);
    }
}
