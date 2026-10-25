using System.Net;
using MEditService.Http.Tests.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class ProjectionSequenceApiTests : HostedTests
{
    [Fact]
    public async Task AwaitSequence_NonPositiveTimeout_Returns400()
    {
        var response = await Client.GetAsync(new Uri("/load-order/sequence/await?atLeast=1&timeoutMs=0", UriKind.Relative));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
