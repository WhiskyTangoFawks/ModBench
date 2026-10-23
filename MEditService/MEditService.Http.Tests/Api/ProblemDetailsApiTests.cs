using System.Net;
using System.Net.Http.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class ProblemDetailsApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private const string Origin = "NoLoadOrderMod";
    private static readonly object Plugin = new { name = "New.esp", origin = Origin };

    private readonly TestPluginFixture _fixture = loaded.Plugin;

    public sealed class Route(string name, Func<HttpClient, string, Task<HttpResponseMessage>> send)
    {
        public Task<HttpResponseMessage> Send(HttpClient client, string dataFolder) => send(client, dataFolder);

        public override string ToString() => name;
    }

    public static TheoryData<Route> NoLoadOrderRoutes =>
    [
        new("GET /plugins", (client, _) => client.GetAsync("/plugins")),
        new("POST /decompile-and-commit", (client, _) => client.DecompileAndCommit(Origin)),
        new("POST /plugins/decompile", (client, _) => client.Decompile([("New.esp", Origin)])),
        new(
            "POST /plugins/decompile-and-repair",
            (client, _) => client.PostAsJsonAsync(
                "/plugins/decompile-and-repair", new { plugins = new[] { new { plugin = Plugin, hash = "h", sourceFolder = "s" } }, force = false })),
        new("POST /plugins/compile", (client, _) => client.Compile([("New.esp", Origin)])),
        new("POST /build", (client, _) => client.Build([(Origin, Origin)], "stat-cache")),
        new(
            "POST /plugins/create",
            (client, dataFolder) => client.PostAsJsonAsync(
                "/plugins/create", new { origin = Origin, name = "New.esp", folder = Path.Combine(dataFolder, Origin) })),
        new(
            "POST /plugins/rename-source-changes",
            (client, _) => client.PostAsJsonAsync("/plugins/rename-source-changes", new { origin = Origin, name = "New.esp", newName = "Renamed.esp" })),
        new(
            "POST /records/delete-changes",
            (client, _) => client.PostAsJsonAsync("/records/delete-changes", new { records = new[] { new { formKey = "000800:New.esp", plugin = Plugin } } })),
    ];

    [Fact]
    public async Task PutLoadOrder_AnUnknownGameRelease_Is400()
    {
        var response = await loaded.Client.PutAsJsonAsync("/load-order", new
        {
            plugins = _fixture.Plugins.Select(p => p.Wire),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(_fixture.Plugins),
            archives = Array.Empty<string>(),
            stringsFiles = Array.Empty<string>(),
            mods = Array.Empty<object>(),
            places = Array.Empty<object>(),
            statCache = "stat-cache",
            dataFolder = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            gameRelease = "NotAGame",
        });

        await response.AssertIsProblem(HttpStatusCode.BadRequest);
    }

    [Theory]
    [MemberData(nameof(NoLoadOrderRoutes))]
    public async Task ARefusalFamily_WithNoLoadOrder_Answers503_WithTheExactNoLoadOrderProblem(Route route)
    {
        await using var app = new MEditHost();

        var problem = await (await route.Send(app.CreateClient(), _fixture.DataFolder)).AssertIsProblem(HttpStatusCode.ServiceUnavailable);

        Assert.Equal(LoadOrder.NoLoadOrderException.DefaultMessage, problem.GetProperty("detail").GetString());
        Assert.Equal("Service Unavailable", problem.GetProperty("title").GetString());
        Assert.Equal("NoLoadOrder", problem.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task CreatePlugin_AFolderHoldingADirectoryOfThePluginsName_Is422_WriteFailed()
    {
        using var scratch = new ScratchDirectory("problem-details-create-");
        Directory.CreateDirectory(Path.Combine(scratch, "New.esp"));

        var response = await loaded.Client.PostAsJsonAsync("/plugins/create", new { origin = Origin, name = "New.esp", folder = scratch.ToString() });

        var problem = await response.AssertIsProblem(HttpStatusCode.UnprocessableEntity);
        Assert.Equal("WriteFailed", problem.GetProperty("refusal").GetString());
    }
}
