using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

[Collection(WebHostCollection.Name)]
public sealed class ProblemDetailsApiTests(LoadedApiFixture<TestPluginFixture> loaded) : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private const string ProblemContentType = "application/problem+json";

    private readonly HttpClient _client = loaded.Client;
    private readonly TestPluginFixture _fixture = loaded.Plugin;

    private static JsonElement AssertIsProblemDetails(HttpResponseMessage response, int expectedStatus)
    {
        var ct = response.Content.Headers.ContentType?.MediaType;
        Assert.Equal(ProblemContentType, ct);

        var body = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        var doc = JsonDocument.Parse(body).RootElement;
        Assert.Equal(expectedStatus, doc.GetProperty("status").GetInt32());
        return doc;
    }

    // --- POST /load-order ---

    [Theory]
    [InlineData("badGameDir", null, "Fallout4")]
    [InlineData(null, "badInstance", "Fallout4")]
    [InlineData(null, null, "NotAGame")]
    public async Task PutLoadOrder_InvalidInput_ReturnsProblemDetails400(
        string? badGameDir, string? badInstance, string gameRelease)
    {
        var resp = await _client.PutAsJsonAsync("/load-order", new
        {
            plugins = _fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameDirectory = badGameDir ?? _fixture.DataFolder,
            instanceRoot = badInstance ?? _fixture.InstanceRoot,
            gameRelease,
        });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        AssertIsProblemDetails(resp, 400);
    }

    // A GameRelease with no Mutagen assembly is a client error, not a server fault. Its own
    // factory: BeginLoad tears down the loaded load order before the support probe runs.
    [Fact]
    public async Task PutLoadOrder_UnsupportedGameRelease_ReturnsProblemDetails400WithActionableMessage()
    {
        await using var app = new MEditHost();
        var client = app.CreateClient();

        var resp = await client.PutAsJsonAsync("/load-order", new
        {
            plugins = _fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
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

    // A name that collides with an already-created plugin at the same destination. The fixture's own
    // listed plugin lives in the Data directory, so this creates the destination's first plugin,
    // then collides.
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

    // --- No load order ---

    [Theory]
    [InlineData("createPlugin", 503)]
    [InlineData("getFilter", 503)]
    [InlineData("track", 503)]
    [InlineData("deleteRecord", 503)]
    // Each route's own "no load order" guard: the request body's validation passes (real values
    // below), so the request reaches the no-load-order branch and the 503 these routes declare
    // via .ProducesProblem(503).
    public async Task Endpoint_NoLoadOrder_ReturnsProblemDetails(string op, int expectedStatus)
    {
        await using var app = new MEditHost();
        var client = app.CreateClient();

        var realPluginPath = Path.Combine(_fixture.DataFolder, TestPluginFixture.PluginName);

        var resp = op switch
        {
            "createPlugin" => await client.PostAsJsonAsync(
                "/plugins/create", new { name = "New.esp", path = Path.Combine(_fixture.DataFolder, "NoLoadOrderMod"), origin = "NoLoadOrderMod" }),
            "getFilter" => await client.GetAsync("/load-order/filter"),
            "track" => await client.PostAsJsonAsync("/plugins/track", new { origin = "NoLoadOrderMod", preset = "Edits" }),
            "deleteRecord" => await client.PostAsJsonAsync("/records/delete", new
            {
                records = new[] { new { formKey = "000800:New.esp", plugin = "New.esp", origin = "NoLoadOrderMod" } },
            }),
            _ => throw new ArgumentOutOfRangeException(nameof(op), op, "Unknown operation"),
        };

        var problem = AssertIsProblemDetails(resp, expectedStatus);
        Assert.Contains("load order", problem.GetProperty("detail").GetString(), StringComparison.OrdinalIgnoreCase);
    }

}
