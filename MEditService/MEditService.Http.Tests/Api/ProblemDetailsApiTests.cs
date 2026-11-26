using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class ProblemDetailsApiTests(ProblemDetailsApiTests.Unloaded unloaded) : IClassFixture<ProblemDetailsApiTests.Unloaded>
{
    public sealed class Unloaded : IDisposable
    {
        private readonly MEditHost _app = new();

        public Unloaded() => Client = _app.CreateClient();

        public HttpClient Client { get; }

        public void Dispose()
        {
            Client.Dispose();
            _app.Dispose();
        }
    }

    private const string Origin = "NoLoadOrderMod";
    private static readonly object Plugin = new { name = "New.esp", origin = Origin };

    public sealed class Route(string name, Func<HttpClient, Task<HttpResponseMessage>> send)
    {
        public Task<HttpResponseMessage> Send(HttpClient client) => send(client);

        public override string ToString() => name;
    }

    public static TheoryData<Route> NoLoadOrderRoutes =>
    [
        new("GET /plugins", client => client.GetAsync("/plugins")),
        new("POST /version-in-git", client => client.VersionInGit(Origin)),
        new("POST /plugins/decompile", client => client.Decompile([("New.esp", Origin)])),
        new(
            "POST /plugins/decompile-and-repair",
            client => client.PostAsJsonAsync(
                "/plugins/decompile-and-repair", new { plugins = new[] { new { plugin = Plugin, hash = "h" } }, force = false })),
        new("POST /plugins/compile", client => client.Compile([("New.esp", Origin)])),
        new("POST /build", client => client.Build([(Origin, Origin)], new { compile = new[] { "New.esp" } })),
        new(
            "POST /plugins/create",
            client => client.PostAsJsonAsync(
                "/plugins/create", new { origin = Origin, name = "New.esp", folder = Origin, flags = Array.Empty<string>() })),
        new(
            "POST /plugins/rename-source-changes",
            client => client.PostAsJsonAsync("/plugins/rename-source-changes", new { origin = Origin, name = "New.esp", newName = "Renamed.esp" })),
        new(
            "POST /plugins/make-patch",
            client => client.PostAsJsonAsync("/plugins/make-patch", new { origin = Origin, name = "New.esp", records = Array.Empty<object>() })),
        new("POST /plugin-source/names", client => client.PostAsJsonAsync("/plugin-source/names", new { text = "{}" })),
        new(
            "POST /records/delete-changes",
            client => client.PostAsJsonAsync("/records/delete-changes", new { records = new[] { new { formKey = "000800:New.esp", plugin = Plugin } } })),
    ];

    [Theory]
    [MemberData(nameof(NoLoadOrderRoutes))]
    public async Task ARefusalFamily_WithNoLoadOrder_Answers503_WithTheExactNoLoadOrderProblem(Route route)
    {
        var problem = await (await route.Send(unloaded.Client)).AssertIsProblem(HttpStatusCode.ServiceUnavailable);

        Assert.Equal(LoadOrder.NoLoadOrderException.DefaultMessage, problem.GetProperty("detail").GetString());
        Assert.Equal("Service Unavailable", problem.GetProperty("title").GetString());
        Assert.Equal("NoLoadOrder", problem.GetProperty("refusal").GetString());
    }
}
