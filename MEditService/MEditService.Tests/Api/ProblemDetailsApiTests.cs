using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

public sealed class ProblemDetailsApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private const string ProblemContentType = "application/problem+json";

    private readonly HttpClient _client = loaded.Client;
    private readonly TestPluginFixture _fixture = loaded.Plugin;

    private static void AssertIsProblemDetails(HttpResponseMessage response, int expectedStatus)
    {
        var ct = response.Content.Headers.ContentType?.MediaType;
        Assert.Equal(ProblemContentType, ct);

        var body = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        var doc = JsonDocument.Parse(body).RootElement;
        Assert.Equal(expectedStatus, doc.GetProperty("status").GetInt32());
    }

    // --- POST /session/load ---

    [Theory]
    [InlineData("badFolder", null, "Fallout4")]
    [InlineData(null, "badPlugins", "Fallout4")]
    [InlineData(null, null, "NotAGame")]
    public async Task SessionLoad_InvalidInput_ReturnsProblemDetails400(
        string? badFolder, string? badPlugins, string gameRelease)
    {
        var resp = await _client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = badFolder ?? _fixture.DataFolder,
            pluginsTxtPath = badPlugins ?? _fixture.PluginsTxtPath,
            gameRelease,
        });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        AssertIsProblemDetails(resp, 400);
    }

    // --- POST /plugins/create ---

    [Theory]
    [InlineData("", 400)]
    [InlineData("Plugin.txt", 400)]
    [InlineData(TestPluginFixture.PluginName, 409)]
    public async Task CreatePlugin_InvalidInput_ReturnsProblemDetails(string name, int expectedStatus)
    {
        var resp = await _client.PostAsJsonAsync("/plugins/create", new { name });

        Assert.Equal((HttpStatusCode)expectedStatus, resp.StatusCode);
        AssertIsProblemDetails(resp, expectedStatus);
    }

    // --- No session ---

    [Theory]
    [InlineData("createPlugin", 503)]
    [InlineData("recordTypes", 503)]
    [InlineData("conditionFunctions", 503)]
    [InlineData("conditionRunOnTargets", 503)]
    // #310: LoadUnlistedPlugin/UnloadUnlistedPlugin's own "no session" guards — the path/plugin
    // check on each request body passes (real values below), so the request reaches
    // SessionManager's `_session is null` branch and the 503 these routes declare via
    // .ProducesProblem(503). The load case needs a path that actually exists on disk (File.Exists
    // runs before the session check), hence the fixture's own already-written plugin file rather
    // than a made-up one.
    [InlineData("loadPlugin", 503)]
    [InlineData("unloadPlugin", 503)]
    public async Task Endpoint_NoSession_ReturnsProblemDetails(string op, int expectedStatus)
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();

        var realPluginPath = Path.Combine(_fixture.DataFolder, TestPluginFixture.PluginName);

        var resp = op switch
        {
            "createPlugin" => await client.PostAsJsonAsync("/plugins/create", new { name = "New.esp" }),
            "recordTypes" => await client.GetAsync("/record-types"),
            "conditionFunctions" => await client.GetAsync("/condition-functions"),
            "conditionRunOnTargets" => await client.GetAsync("/condition-run-on-targets"),
            "loadPlugin" => await client.PostAsJsonAsync("/plugins/load", new { path = realPluginPath, origin = "ModA" }),
            "unloadPlugin" => await client.PostAsJsonAsync("/plugins/unload", new { plugin = TestPluginFixture.PluginName, origin = "ModA" }),
            _ => throw new ArgumentOutOfRangeException(nameof(op), op, "Unknown operation"),
        };

        AssertIsProblemDetails(resp, expectedStatus);
    }

    // --- POST /plugins/load, path not found (#310) ---

    // Distinct from the no-session case above: a session *is* loaded here (the shared `loaded`
    // fixture), so this exercises LoadUnlistedPlugin's other declared guard —
    // FileNotFoundException -> 404 — rather than the "no session" one. File.Exists runs before the
    // session check, so this path is reachable regardless of session state; asserting it here
    // (session live) is the more realistic caller shape (the visibility toggle re-issuing load for
    // a copy that has since been deleted from disk).
    [Fact]
    public async Task LoadUnlistedPlugin_PathNotFound_ReturnsProblemDetails404()
    {
        var missingPath = Path.Combine(_fixture.DataFolder, "DoesNotExist.esp");

        var resp = await _client.PostAsJsonAsync("/plugins/load", new { path = missingPath, origin = "ModA" });

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        AssertIsProblemDetails(resp, 404);
    }
}
