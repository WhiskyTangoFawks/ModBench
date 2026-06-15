using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

public sealed class ProblemDetailsApiTests : IClassFixture<LoadedNpcApiFixture>
{
    private const string ProblemContentType = "application/problem+json";

    private readonly HttpClient _client;
    private readonly TestPluginFixture _fixture;

    public ProblemDetailsApiTests(LoadedNpcApiFixture loaded)
    {
        _client = loaded.Client;
        _fixture = loaded.Plugin;
    }

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
    [InlineData("patch", 500)]
    [InlineData("copy", 500)]
    [InlineData("save", 500)]
    public async Task Endpoint_NoSession_ReturnsProblemDetails(string op, int expectedStatus)
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();

        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());
        var plugin = Uri.EscapeDataString(TestPluginFixture.PluginName);

        var resp = op switch
        {
            "createPlugin" => await client.PostAsJsonAsync("/plugins/create", new { name = "New.esp" }),
            "patch" => await client.PatchAsJsonAsync($"/records/{formKey}", new
            {
                plugin = TestPluginFixture.PluginName,
                fields = new Dictionary<string, object?> { ["editor_id"] = "x" },
            }),
            "copy" => await client.PostAsJsonAsync($"/plugins/{plugin}/records", new { recordType = "npc_" }),
            _ => await client.PostAsync($"/plugins/{plugin}/save", null),
        };

        AssertIsProblemDetails(resp, expectedStatus);
    }
}
