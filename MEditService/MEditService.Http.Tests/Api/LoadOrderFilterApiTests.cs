using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class LoadOrderFilterApiTests : HostedTests
{
    private async Task Loaded()
    {
        var fixture = Owned(TestPluginFixture.Create());
        (await Client.PutLoadOrderAndAwaitReady(SnapshotPlugins.Body(fixture.DataFolder, fixture.InstanceRoot, fixture.Plugins)))
            .EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task SettingAFilter_Is204_AndGettingIt_AnswersTheSqlAndItsSource()
    {
        await Loaded();

        Assert.Equal(HttpStatusCode.NoContent, (await Client.SetFilter()).StatusCode);

        var body = await Client.GetFromJsonAsync<JsonElement>("/load-order/filter");
        Assert.Equal("SELECT form_key FROM \"NPC_\"", body.GetProperty("sql").GetString());
        Assert.Equal("npcs.sql", body.GetProperty("source").GetString());
    }

    [Fact]
    public async Task PostFilter_SqlNamingAColumnNoRelationHas_Returns400SayingWhy()
    {
        await Loaded();

        var resp = await Client.PostAsJsonAsync("/load-order/filter", new { sql = "SELECT form_key FROM \"NPC_\" WHERE no_such_column = 1", source = "wrong.sql" });

        var problem = await resp.AssertIsProblem(HttpStatusCode.BadRequest);
        Assert.Contains("no_such_column", problem.GetProperty("detail").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ClearingTheFilter_Is204_AndGettingIt_AnswersNoFilterInForce()
    {
        await Loaded();
        await Client.SetFilter();

        Assert.Equal(HttpStatusCode.NoContent, (await Client.DeleteAsync("/load-order/filter")).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await Client.GetAsync("/load-order/filter")).StatusCode);
    }
}
