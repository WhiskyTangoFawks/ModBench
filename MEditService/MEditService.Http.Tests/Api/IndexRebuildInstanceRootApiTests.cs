using System.Net;
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
}
