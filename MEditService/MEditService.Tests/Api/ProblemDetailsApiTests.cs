using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

[Collection("ApiTests")]
public sealed class ProblemDetailsApiTests : IClassFixture<TestPluginFixture>
{
    private const string ProblemContentType = "application/problem+json";

    private readonly TestPluginFixture _fixture;
    private readonly WebApplicationFactory<Program> _app;

    public ProblemDetailsApiTests(TestPluginFixture fixture, ApiWebAppFixture webApp)
    {
        _fixture = fixture;
        _app = webApp.App;
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
        var client = _app.CreateClient();
        var resp = await client.PostAsJsonAsync("/session/load", new
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
        var client = _app.CreateClient();
        await LoadSession(client);

        var resp = await client.PostAsJsonAsync("/plugins/create", new { name });

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
            "copy" => await client.PostAsync($"/records/{formKey}/copy-to/{plugin}", null),
            _ => await client.PostAsync($"/plugins/{plugin}/save", null),
        };

        AssertIsProblemDetails(resp, expectedStatus);
    }

    private async Task LoadSession(HttpClient client)
    {
        var resp = await client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = _fixture.DataFolder,
            pluginsTxtPath = _fixture.PluginsTxtPath,
            gameRelease = "Fallout4",
        });
        resp.EnsureSuccessStatusCode();
    }
}
