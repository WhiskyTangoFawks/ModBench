using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class IndexRebuildInstanceRootApiTests : HostedTests
{
    private Task<HttpResponseMessage> Rebuild(string instanceRoot) =>
        Client.PostAsJsonAsync("/index/rebuild", new { instanceRoot, gameRelease = "Fallout4" });

    [Fact]
    public async Task RebuildingAnInstanceRootThatIsNotThere_Is400()
    {
        using var parent = new ScratchDirectory("medit-rebuild-");

        var rebuilt = await Rebuild(Path.Combine(parent, "no-such-instance"));

        Assert.Equal(HttpStatusCode.BadRequest, rebuilt.StatusCode);
    }
}
