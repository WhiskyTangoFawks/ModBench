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

    [Fact]
    public async Task PutLoadOrder_AnUnknownGameRelease_Is400()
    {
        var resp = await _client.PutAsJsonAsync("/load-order", new
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

        AssertIsProblemDetails(resp, 400);
    }

    [Theory]
    [InlineData("indexRefusal")]
    [InlineData("decompile-and-commit")]
    [InlineData("decompile")]
    [InlineData("decompile-and-repair")]
    [InlineData("compile")]
    [InlineData("build")]
    [InlineData("createPlugin")]
    [InlineData("renameSourceChanges")]
    [InlineData("recordEdit")]
    public async Task EachRefusalFamily_WithNoLoadOrder_Answers503_WithTheExactNoLoadOrderProblem(string family)
    {
        await using var app = new MEditHost();
        var client = app.CreateClient();
        var plugin = new { name = "New.esp", origin = "NoLoadOrderMod" };

        var response = family switch
        {
            "indexRefusal" => await client.GetAsync("/plugins"),
            "decompile-and-commit" => await client.DecompileAndCommit("NoLoadOrderMod"),
            "decompile" => await client.Decompile([("New.esp", "NoLoadOrderMod")]),
            "decompile-and-repair" => await client.PostAsJsonAsync(
                "/plugins/decompile-and-repair", new { plugins = new[] { new { plugin, hash = "h", sourceFolder = "s" } }, force = false }),
            "compile" => await client.Compile([("New.esp", "NoLoadOrderMod")]),
            "build" => await client.Build([("NoLoadOrderMod", "NoLoadOrderMod")], "stat-cache"),
            "createPlugin" => await client.PostAsJsonAsync(
                "/plugins/create", new { origin = "NoLoadOrderMod", name = "New.esp", folder = Path.Combine(_fixture.DataFolder, "NoLoadOrderMod") }),
            "renameSourceChanges" => await client.PostAsJsonAsync(
                "/plugins/rename-source-changes", new { plugin.origin, plugin.name, newName = "Renamed.esp" }),
            "recordEdit" => await client.PostAsJsonAsync("/records/delete-changes", new
            {
                records = new[] { new { formKey = "000800:New.esp", plugin } }
            }),
            _ => throw new ArgumentOutOfRangeException(nameof(family), family, "Unknown refusal family"),
        };

        var problem = AssertIsProblemDetails(response, 503);
        Assert.Equal(LoadOrder.NoLoadOrderException.DefaultMessage, problem.GetProperty("detail").GetString());
        Assert.Equal("Service Unavailable", problem.GetProperty("title").GetString());
        Assert.Equal("NoLoadOrder", problem.GetProperty("refusal").GetString());
    }
}
