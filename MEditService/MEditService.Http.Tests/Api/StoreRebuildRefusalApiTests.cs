using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.RecordIndex.Queries;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class StoreRebuildRefusalApiTests
{
    [Theory]
    [InlineData(StoreRebuildRefusal.HeldByAnotherWindow, HttpStatusCode.Locked)]
    [InlineData(StoreRebuildRefusal.StillServingReads, HttpStatusCode.InternalServerError)]
    public async Task PostRebuildIndex_ARefusedStore_AnswersItsStatus_NamingTheRefusal(StoreRebuildRefusal refusal, HttpStatusCode status)
    {
        await using var app = new MEditHost(services => FailingQueries.Replace(services, new StoreRebuildRefused(refusal, "The store said no.")));
        using var instance = new ScratchDirectory("medit-rebuild-");

        var problem = await (await app.CreateClient().RebuildIndex(instance.ToString())).AssertIsProblem(status);

        Assert.Equal("The store said no.", problem.GetProperty("detail").GetString());
        Assert.Equal(refusal.ToString(), problem.GetProperty("refusal").GetString());
    }
}
