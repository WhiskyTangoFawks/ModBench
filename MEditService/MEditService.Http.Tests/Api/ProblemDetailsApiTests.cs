using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

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

    [Theory]
    [InlineData("badGameDir", null, "Fallout4")]
    [InlineData(null, "badInstance", "Fallout4")]
    [InlineData(null, null, "NotAGame")]
    public async Task PutLoadOrder_InvalidInput_ReturnsProblemDetails400(
        string? badGameDir, string? badInstance, string gameRelease)
    {
        var resp = await _client.PutAsJsonAsync("/load-order", new
        {
            plugins = _fixture.Plugins.Select(p => p.Wire),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(_fixture.Plugins),
            gameDirectory = badGameDir ?? _fixture.DataFolder,
            instanceRoot = badInstance ?? _fixture.InstanceRoot,
            gameRelease,
        });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        AssertIsProblemDetails(resp, 400);
    }

    [Fact]
    public async Task PutLoadOrder_UnsupportedGameRelease_ReturnsProblemDetails400WithActionableMessage()
    {
        await using var app = new MEditHost();
        var client = app.CreateClient();

        var resp = await client.PutAsJsonAsync("/load-order", new
        {
            plugins = _fixture.Plugins.Select(p => p.Wire),
            active = SnapshotPlugins.Active(_fixture.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(_fixture.Plugins),
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

    [Theory]
    [InlineData("", 400)]
    [InlineData("Plugin.txt", 400)]
    public async Task CreatePlugin_InvalidInput_ReturnsProblemDetails(string name, int expectedStatus)
    {
        var resp = await _client.PostAsJsonAsync(
            "/plugins/create", new { origin = "ProblemDetailsMod", name, folder = Path.Combine(_fixture.DataFolder, "ProblemDetailsMod") });

        Assert.Equal((HttpStatusCode)expectedStatus, resp.StatusCode);
        AssertIsProblemDetails(resp, expectedStatus);
    }

    [Fact]
    public async Task CreatePlugin_DuplicateAtSameDestination_ReturnsProblemDetails409()
    {
        var modFolder = Directory.CreateDirectory(Path.Combine(_fixture.DataFolder, "DuplicateDestMod")).FullName;
        var first = await _client.PostAsJsonAsync("/plugins/create", new { origin = "DuplicateDestMod", name = "Dup.esp", folder = modFolder });
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);

        var resp = await _client.PostAsJsonAsync("/plugins/create", new { origin = "DuplicateDestMod", name = "Dup.esp", folder = modFolder });

        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
        AssertIsProblemDetails(resp, 409);
    }

    [Theory]
    [InlineData("createPlugin", 503)]
    [InlineData("getFilter", 503)]
    [InlineData("track", 503)]
    [InlineData("deleteRecord", 503)]
    [InlineData("setFilter", 503)]
    [InlineData("getPluginDiagnoses", 503)]
    [InlineData("decompilePlugin", 503)]
    [InlineData("copyRecord", 503)]
    public async Task Endpoint_WithAValidRequestAndNoLoadOrder_ReturnsProblemDetails(string op, int expectedStatus)
    {
        await using var app = new MEditHost();
        var client = app.CreateClient();

        var realPluginPath = Path.Combine(_fixture.DataFolder, TestPluginFixture.PluginName);

        var resp = op switch
        {
            "createPlugin" => await client.PostAsJsonAsync(
                "/plugins/create", new { origin = "NoLoadOrderMod", name = "New.esp", folder = Path.Combine(_fixture.DataFolder, "NoLoadOrderMod") }),
            "getFilter" => await client.GetAsync("/load-order/filter"),
            "setFilter" => await client.PostAsJsonAsync("/load-order/filter", new { sql = "SELECT form_key FROM \"NPC_\"", source = "npcs.sql" }),
            "getPluginDiagnoses" => await client.GetAsync("/plugins/diagnoses"),
            "decompilePlugin" => await client.Decompile([("New.esp", "NoLoadOrderMod")]),
            "copyRecord" => await client.Copy("000800:New.esp", ("New.esp", "NoLoadOrderMod"), "Override", ("Dest.esp", "DestMod")),
            "track" => await client.PostAsJsonAsync("/plugins/track", new { mods = new[] { "NoLoadOrderMod" } }),
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
