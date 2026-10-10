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
    [InlineData("deleteRecordChanges", 503)]
    [InlineData("setFilter", 503)]
    [InlineData("getReferences", 503)]
    [InlineData("getPluginDiagnoses", 503)]
    [InlineData("decompilePlugin", 503)]
    [InlineData("copyRecord", 503)]
    [InlineData("getContainerChildren", 503)]
    [InlineData("getPlugins", 503)]
    [InlineData("getRecords", 503)]
    [InlineData("getRecord", 503)]
    [InlineData("compareRecord", 503)]
    [InlineData("getPluginRecordTypes", 503)]
    [InlineData("getWorldspaces", 503)]
    [InlineData("getWorldspaceBlocks", 503)]
    [InlineData("getCellChildRecords", 503)]
    [InlineData("getInteriorCells", 503)]
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
            "setFilter" => await client.SetFilter(),
            "getReferences" => await client.GetAsync("/records/000800%3ANew.esp/references"),
            "getPluginDiagnoses" => await client.GetAsync("/plugins/diagnoses"),
            "decompilePlugin" => await client.Decompile([("New.esp", "NoLoadOrderMod")]),
            "copyRecord" => await client.Copy("000800:New.esp", ("New.esp", "NoLoadOrderMod"), "Override", ("Dest.esp", "DestMod")),
            "getContainerChildren" => await client.GetAsync("/plugins/New.esp/records/000800%3ANew.esp/children?origin=NoLoadOrderMod"),
            "getPlugins" => await client.GetAsync("/plugins"),
            "getRecords" => await client.GetAsync("/records"),
            "getRecord" => await client.GetAsync("/records/000800%3ANew.esp"),
            "compareRecord" => await client.GetAsync("/records/000800%3ANew.esp/compare"),
            "getPluginRecordTypes" => await client.GetAsync("/plugins/New.esp/record-types?origin=NoLoadOrderMod"),
            "getWorldspaces" => await client.GetAsync("/plugins/New.esp/worldspaces?origin=NoLoadOrderMod"),
            "getWorldspaceBlocks" => await client.GetAsync("/plugins/New.esp/worldspaces/000800%3ANew.esp/blocks?origin=NoLoadOrderMod"),
            "getCellChildRecords" => await client.GetAsync("/plugins/New.esp/cells/000800%3ANew.esp/children?origin=NoLoadOrderMod"),
            "getInteriorCells" => await client.GetAsync("/plugins/New.esp/interior-cells?origin=NoLoadOrderMod"),
            "track" => await client.PostAsJsonAsync("/plugins/track", new { mods = new[] { "NoLoadOrderMod" } }),
            "deleteRecordChanges" => await client.PostAsJsonAsync("/records/delete-changes", new
            {
                records = new[] { new { formKey = "000800:New.esp", plugin = "New.esp", origin = "NoLoadOrderMod" } }
            }),
            _ => throw new ArgumentOutOfRangeException(nameof(op), op, "Unknown operation"),
        };

        var problem = AssertIsProblemDetails(resp, expectedStatus);
        Assert.Contains("load order", problem.GetProperty("detail").GetString(), StringComparison.OrdinalIgnoreCase);
        if (expectedStatus == 503)
        {
            Assert.Equal(LoadOrder.NoLoadOrderException.DefaultMessage, problem.GetProperty("detail").GetString());
            Assert.Equal("Service Unavailable", problem.GetProperty("title").GetString());
        }
    }

    [Fact]
    public async Task ANoLoadOrderAnswer_StillCarriesTheCorsHeaders()
    {
        await using var app = new MEditHost();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/plugins");
        request.Headers.Add("Origin", "https://example.test");

        var response = await app.CreateClient().SendAsync(request);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.True(response.Headers.Contains("Access-Control-Allow-Origin"));
    }
}
