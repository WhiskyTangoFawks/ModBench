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

    // --- POST /session/load-explicit ---

    [Theory]
    [InlineData("badGameDir", null, "Fallout4")]
    [InlineData(null, "badInstance", "Fallout4")]
    [InlineData(null, null, "NotAGame")]
    public async Task SessionLoadExplicit_InvalidInput_ReturnsProblemDetails400(
        string? badGameDir, string? badInstance, string gameRelease)
    {
        var resp = await _client.PostAsJsonAsync("/session/load-explicit", new
        {
            plugins = _fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Participates }),
            gameDirectory = badGameDir ?? _fixture.DataFolder,
            instanceRoot = badInstance ?? _fixture.InstanceRoot,
            gameRelease,
        });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        AssertIsProblemDetails(resp, 400);
    }

    // #445: a syntactically valid GameRelease this build has no Mutagen assembly for (SkyrimSE,
    // genuinely unreferenced — see SchemaReflectorAvailabilityTests) is a client error, not a
    // server fault: 400 with the typed, actionable message, not a 500 wrapping an assembly-load
    // exception. Game directory/instance root are the fixture's real (FO4) paths, never actually read —
    // SessionManager.RunLoad's BeginLoad unconditionally tears down whatever session was
    // previously loaded before the new load's assembly-support probe even runs, so this uses its
    // own isolated WebApplicationFactory (same pattern as Endpoint_NoSession_ReturnsProblemDetails
    // below) rather than the shared LoadedApiFixture's client — reusing that client here would
    // silently dispose the fixture's session out from under every other test in this class.
    [Fact]
    public async Task SessionLoadExplicit_UnsupportedGameRelease_ReturnsProblemDetails400WithActionableMessage()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();

        var resp = await client.PostAsJsonAsync("/session/load-explicit", new
        {
            plugins = _fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Participates }),
            gameDirectory = _fixture.DataFolder,
            instanceRoot = _fixture.InstanceRoot,
            gameRelease = "SkyrimSE",
        });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        AssertIsProblemDetails(resp, 400);
        var body = await resp.Content.ReadAsStringAsync();
        Assert.Contains("SkyrimSE", body);
        Assert.Contains("Mutagen.Bethesda.Skyrim", body);
    }

    // --- POST /plugins/create ---

    [Theory]
    [InlineData("", 400)]
    [InlineData("Plugin.txt", 400)]
    public async Task CreatePlugin_InvalidInput_ReturnsProblemDetails(string name, int expectedStatus)
    {
        var resp = await _client.PostAsJsonAsync(
            "/plugins/create", new { name, path = Path.Combine(_fixture.DataFolder, "ProblemDetailsMod"), origin = "ProblemDetailsMod" });

        Assert.Equal((HttpStatusCode)expectedStatus, resp.StatusCode);
        AssertIsProblemDetails(resp, expectedStatus);
    }

    // #288: a name that collides with an already-created plugin at the same destination — the
    // fixture's own already-listed plugin lives in the Data directory, not a mod folder, so this
    // creates the destination's first plugin, then collides with it, rather than reusing
    // TestPluginFixture.PluginName the way the old single-arg endpoint could.
    [Fact]
    public async Task CreatePlugin_DuplicateAtSameDestination_ReturnsProblemDetails409()
    {
        var modFolder = Path.Combine(_fixture.DataFolder, "DuplicateDestMod");
        var first = await _client.PostAsJsonAsync("/plugins/create", new { name = "Dup.esp", path = modFolder, origin = "DuplicateDestMod" });
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);

        var resp = await _client.PostAsJsonAsync("/plugins/create", new { name = "Dup.esp", path = modFolder, origin = "DuplicateDestMod" });

        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
        AssertIsProblemDetails(resp, 409);
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
            "createPlugin" => await client.PostAsJsonAsync(
                "/plugins/create", new { name = "New.esp", path = Path.Combine(_fixture.DataFolder, "NoSessionMod"), origin = "NoSessionMod" }),
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
