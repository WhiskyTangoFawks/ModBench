using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.RecordIndex.Queries;

namespace MEditService.Http.Tests.Api;

public sealed class ReadOutOfMemoryApiTests : HostedTests
{
    private const string Refusal = "mEdit's record index ran out of memory for this read: Out of Memory Error: failed to pin block of size 256.0 KiB (953.6 MiB/953.6 MiB used)";

    protected override MEditHost CreateHost() =>
        new(services => FailingQueries.Replace(services, problemsRefusal: new IndexRefused(IndexRefusal.OutOfMemory, Refusal)));

    [Fact]
    public async Task ARead_TheRecordIndexRanOutOfMemoryFor_Is503AndSaysSo()
    {
        var problem = await (await Client.GetAsync(new Uri("/plugins/problems", UriKind.Relative))).AssertIsProblem(HttpStatusCode.ServiceUnavailable);

        Assert.Equal(Refusal, problem.GetProperty("detail").GetString());
    }
}
