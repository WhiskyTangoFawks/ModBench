using System.Net;
using MEditService.Http.Tests.TestSupport;

namespace MEditService.Http.Tests.Api;

/// <summary>ADR-0014's read side: a plain read of the sequence, and a bounded await that answers
/// whether a projection landed rather than sleeping the caller.</summary>
public sealed class ProjectionSequenceApiTests : IDisposable
{
    private readonly MEditHost _app = new();
    private readonly HttpClient _client;

    public ProjectionSequenceApiTests() => _client = _app.CreateClient();

    public void Dispose()
    {
        _client.Dispose();
        _app.Dispose();
    }

    // Landing-while-waiting is retired here: no observable of "waiting" orders the GET and the PUT
    // on their separate connections. SequenceAwaitTests holds the fact at AwaitSequenceAsync's seam.

    [Fact]
    public async Task AwaitSequence_NonPositiveTimeout_Returns400()
    {
        var response = await _client.GetAsync(new Uri("/load-order/sequence/await?atLeast=1&timeoutMs=0", UriKind.Relative));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
