using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class IndexRebuildInstanceRootApiTests : HostedTests
{
    [Fact]
    public async Task RebuildingAnInstanceRootThatIsNotThere_Is400()
    {
        using var parent = new ScratchDirectory("medit-rebuild-");

        var rebuilt = await Client.RebuildIndex(Path.Combine(parent, "no-such-instance"));

        Assert.Equal(HttpStatusCode.BadRequest, rebuilt.StatusCode);
    }

    [Fact]
    public async Task RebuildingWithNoGameRelease_Is400()
    {
        using var instance = new ScratchDirectory("medit-rebuild-");

        var rebuilt = await Client.PostAsJsonAsync("/index/rebuild", new { instanceRoot = instance.ToString() });

        Assert.Equal(HttpStatusCode.BadRequest, rebuilt.StatusCode);
    }
}
