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

    public ProblemDetailsApiTests(TestPluginFixture fixture) => _fixture = fixture;

    private static void AssertIsProblemDetails(HttpResponseMessage response, int expectedStatus)
    {
        var ct = response.Content.Headers.ContentType?.MediaType;
        Assert.Equal(ProblemContentType, ct);

        var body = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        var doc  = JsonDocument.Parse(body).RootElement;
        Assert.Equal(expectedStatus, doc.GetProperty("status").GetInt32());
    }

    // --- POST /session/load ---

    [Fact]
    public async Task SessionLoad_MissingDataFolder_ReturnsProblemDetails400()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();

        var resp = await client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = "/nonexistent/path",
            pluginsTxtPath = _fixture.PluginsTxtPath,
            gameRelease    = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        AssertIsProblemDetails(resp, 400);
    }

    [Fact]
    public async Task SessionLoad_MissingPluginsTxt_ReturnsProblemDetails400()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();

        var resp = await client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = _fixture.DataFolder,
            pluginsTxtPath = "/nonexistent/Plugins.txt",
            gameRelease    = "Fallout4",
        });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        AssertIsProblemDetails(resp, 400);
    }

    [Fact]
    public async Task SessionLoad_InvalidGameRelease_ReturnsProblemDetails400()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();

        var resp = await client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = _fixture.DataFolder,
            pluginsTxtPath = _fixture.PluginsTxtPath,
            gameRelease    = "NotARealGame",
        });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        AssertIsProblemDetails(resp, 400);
    }

    // --- POST /plugins/create ---

    [Fact]
    public async Task CreatePlugin_EmptyName_ReturnsProblemDetails400()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();
        await LoadSession(client);

        var resp = await client.PostAsJsonAsync("/plugins/create", new { name = "" });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        AssertIsProblemDetails(resp, 400);
    }

    [Fact]
    public async Task CreatePlugin_InvalidExtension_ReturnsProblemDetails400()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();
        await LoadSession(client);

        var resp = await client.PostAsJsonAsync("/plugins/create", new { name = "Plugin.txt" });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        AssertIsProblemDetails(resp, 400);
    }

    [Fact]
    public async Task CreatePlugin_AlreadyExists_ReturnsProblemDetails409()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();
        await LoadSession(client);

        var resp = await client.PostAsJsonAsync("/plugins/create",
            new { name = TestPluginFixture.PluginName });

        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
        AssertIsProblemDetails(resp, 409);
    }

    [Fact]
    public async Task CreatePlugin_NoSession_ReturnsProblemDetails503()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();

        var resp = await client.PostAsJsonAsync("/plugins/create", new { name = "New.esp" });

        Assert.Equal(HttpStatusCode.ServiceUnavailable, resp.StatusCode);
        AssertIsProblemDetails(resp, 503);
    }

    // --- PATCH /records/{formKey} ---

    [Fact]
    public async Task PatchRecord_NoSession_ReturnsProblemDetails500()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client  = app.CreateClient();
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        var resp = await client.PatchAsJsonAsync($"/records/{formKey}", new
        {
            plugin = TestPluginFixture.PluginName,
            fields = new Dictionary<string, object?> { ["editor_id"] = "x" },
        });

        Assert.Equal(HttpStatusCode.InternalServerError, resp.StatusCode);
        AssertIsProblemDetails(resp, 500);
    }

    // --- POST /records/{formKey}/copy-to/{plugin} ---

    [Fact]
    public async Task CopyRecord_NoSession_ReturnsProblemDetails500()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client  = app.CreateClient();
        var formKey = Uri.EscapeDataString(_fixture.Npc1FormKey.ToString());

        var resp = await client.PostAsync(
            $"/records/{formKey}/copy-to/{Uri.EscapeDataString(TestPluginFixture.PluginName)}",
            null);

        Assert.Equal(HttpStatusCode.InternalServerError, resp.StatusCode);
        AssertIsProblemDetails(resp, 500);
    }

    // --- POST /plugins/{plugin}/save ---

    [Fact]
    public async Task SavePlugin_NoSession_ReturnsProblemDetails500()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();

        var resp = await client.PostAsync(
            $"/plugins/{Uri.EscapeDataString(TestPluginFixture.PluginName)}/save",
            null);

        Assert.Equal(HttpStatusCode.InternalServerError, resp.StatusCode);
        AssertIsProblemDetails(resp, 500);
    }

    private async Task LoadSession(HttpClient client)
    {
        var resp = await client.PostAsJsonAsync("/session/load", new
        {
            dataFolderPath = _fixture.DataFolder,
            pluginsTxtPath = _fixture.PluginsTxtPath,
            gameRelease    = "Fallout4",
        });
        resp.EnsureSuccessStatusCode();
    }
}
