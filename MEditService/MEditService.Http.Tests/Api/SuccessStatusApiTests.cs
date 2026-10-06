using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class SuccessStatusApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private HttpClient Client => loaded.Client;

    [Fact]
    public async Task Health_Is200Ok()
    {
        var response = await Client.GetAsync(new Uri("/health", UriKind.Relative));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("ok", (await response.Body()).GetProperty("status").GetString());
    }

    [Fact]
    public async Task StreamNotifications_Is200AsAnEventStream()
    {
        var response = await Client.GetAsync(new Uri("/notifications/stream", UriKind.Relative), HttpCompletionOption.ResponseHeadersRead);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task GetSequence_Is200WithTheSequence()
    {
        var response = await Client.GetAsync(new Uri("/load-order/sequence", UriKind.Relative));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(await response.Content.ReadFromJsonAsync<long>() > 0);
    }

    [Fact]
    public async Task AwaitSequence_Is200AnsweringWhetherTheSequenceWasReached()
    {
        var response = await Client.GetAsync(new Uri("/load-order/sequence/await?atLeast=1&timeoutMs=1000", UriKind.Relative));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True((await response.Body()).GetProperty("reached").GetBoolean());
    }

    [Fact]
    public async Task GetPluginDiagnoses_Is200WithAReportPerPlugin()
    {
        var response = await Client.GetAsync(new Uri("/plugins/diagnoses", UriKind.Relative));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(JsonValueKind.Array, (await response.Body()).ValueKind);
    }

    [Fact]
    public async Task GetCreatableRecordTypes_Is200()
    {
        var response = await Client.GetAsync(new Uri("/record-types/creatable", UriKind.Relative));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotEmpty((await response.Body()).EnumerateArray());
    }

    [Fact]
    public async Task GetCreatablePluginExtensions_Is200NamingEachExtension()
    {
        var response = await Client.GetAsync(new Uri("/plugins/creatable-extensions", UriKind.Relative));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal([".esl", ".esm", ".esp"], (await response.Body()).EnumerateArray().Select(e => e.GetString()).Order());
    }
}
