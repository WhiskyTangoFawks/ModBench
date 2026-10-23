using System.Net;
using MEditService.Http.Tests.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class IndexFailureApiTests : HostedTests
{
    protected override MEditHost CreateHost() => new(services => FailingQueries.Replace(services));

    [Fact]
    public async Task AnUnexpectedFailure_AnswersAProblemThatCarriesNoExceptionText()
    {
        var problem = await (await Client.DeleteAsync("/load-order/filter")).AssertIsProblem(HttpStatusCode.InternalServerError);

        Assert.DoesNotContain("The record index failed.", problem.GetRawText(), StringComparison.Ordinal);
    }
}
