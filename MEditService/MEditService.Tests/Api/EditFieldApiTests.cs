using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>
/// #415 AC5: a script or agent editing through the HTTP API lands a working-tree change on the edit
/// branch exactly as the UI does — same service, same single write path, no second door — and an
/// edit against an untracked plugin gets a typed refusal mirroring the UI's.
///
/// "Typed" is the load-bearing word: an agent has to be able to branch on <i>which</i> refusal it
/// got without matching on prose, so the refusal travels as a ProblemDetails extension, not only as
/// a message (ADR-0026).
/// </summary>
public sealed class EditFieldApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private const string Origin = "EditableMod";
    private const string Plugin = "Editable.esp";

    private static ScatteredFixtureData BuildOneModOnePlugin() =>
        new PluginFixtureBuilder("api-edit")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("ApiNpc"), origin: Origin)
            .BuildScattered();

    private async Task LoadOnly(ScatteredFixtureData fx)
    {
        var load = await _client.PostAsJsonAsync("/session/load-explicit", new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Where(p => p.Origin == Origin)
                .Select(p => new { name = p.Name, path = p.Path, origin = p.Origin, participates = true }),
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();
    }

    private async Task<string> FirstNpcFormKey()
    {
        var records = await _client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&type=npc_");
        return records.GetProperty("items")[0].GetProperty("formKey").GetString()!;
    }

    private Task<HttpResponseMessage> PostEdit(string formKey, string fieldPath, object value) =>
        _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/field",
            new { plugin = Plugin, origin = Origin, fieldPath, value });

    [Fact]
    public async Task EditField_OnATrackedPlugin_LandsAsAWorkingTreeChange()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx);
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == Origin).Path)!;
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" })).EnsureSuccessStatusCode();

        var formKey = await FirstNpcFormKey();
        var response = await PostEdit(formKey, "height_max", 0.75);

        response.EnsureSuccessStatusCode();
        Assert.True(JsonSerializer.Deserialize<JsonElement>(await response.Content.ReadAsStringAsync())
            .GetProperty("applied").GetBoolean());

        // The dirt is real dirt, on the edit branch, in the mod's own repo — the same thing the
        // native Source Control panel would be showing a human right now.
        var gitDir = Path.Combine(modFolder, ".git");
        Assert.NotEmpty(GitCli.Run(gitDir, modFolder, "status", "--porcelain"));
        Assert.Equal("edit", GitCli.Run(gitDir, modFolder, "rev-parse", "--abbrev-ref", "HEAD").Trim());
    }

    [Fact]
    public async Task EditField_OnATrackedPlugin_IsVisibleToTheNextRead()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx);
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" })).EnsureSuccessStatusCode();

        var formKey = await FirstNpcFormKey();
        (await PostEdit(formKey, "height_max", 0.75)).EnsureSuccessStatusCode();

        var detail = await _client.GetFromJsonAsync<JsonElement>($"/records/{Uri.EscapeDataString(formKey)}");
        var field = detail.GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == "height_max");
        Assert.Equal(0.75, field.GetProperty("value").GetDouble(), 3);
    }

    [Fact]
    public async Task EditField_OnAnUntrackedPlugin_IsRefusedWithATypedRefusal()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx); // deliberately not tracked
        var formKey = await FirstNpcFormKey();

        var response = await PostEdit(formKey, "height_max", 0.75);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        // The discriminator an agent branches on, beside the prose a human reads.
        Assert.Equal("PluginNotTracked", problem.GetProperty("refusal").GetString());
        Assert.Contains("Track", problem.GetProperty("detail").GetString()!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task EditField_WithAnUnknownField_Is404_WithItsOwnRefusal()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx);
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" })).EnsureSuccessStatusCode();
        var formKey = await FirstNpcFormKey();

        var response = await PostEdit(formKey, "no_such_field", 1);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("FieldNotFound", problem.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task EditField_WhenTheSourceFileCannotBeWritten_IsAShapedProblem_NotAnUnhandled500()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx);
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == Origin).Path)!;
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" })).EnsureSuccessStatusCode();
        var formKey = await FirstNpcFormKey();

        // Never-assume-exclusive-ownership (root CLAUDE.md), made concrete: something outside
        // Modbench replaced this record's source file with a directory. Any I/O failure would do —
        // a lock, a permissions change, a vanished mount — but this one needs no privileges and is
        // deterministic, so it is the one the suite can actually run.
        var records = await _client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&type=npc_");
        // #451: routed through the production path helper (Spriggit-flat layout) rather than
        // hand-reconstructed — "ApiNpc" is BuildOneModOnePlugin's own literal EditorID above.
        // #459: SourceUnitResolver rather than SourceRecordPath.For directly — For now needs an order
        // index this test has no reason to track.
        var sourcePath = SourceUnitResolver.FlatSourcePath(
            modFolder, Plugin, "npc_", formKey, "ApiNpc", GameRelease.Fallout4);
        Assert.True(File.Exists(sourcePath), $"expected a source file at {sourcePath}");
        Assert.NotEqual(0, records.GetProperty("total").GetInt32());
        File.Delete(sourcePath);
        Directory.CreateDirectory(sourcePath);

        var response = await PostEdit(formKey, "height_max", 0.75);

        // A shaped ProblemDetails, the way every sibling write endpoint answers an I/O failure —
        // not an unhandled exception escaping into an empty 500, which is what a client with no
        // body to read cannot tell apart from the backend having died.
        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(string.IsNullOrWhiteSpace(problem.GetProperty("detail").GetString()));
    }

    [Fact]
    public async Task EditField_WithoutAPlugin_Is400()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx);
        var formKey = await FirstNpcFormKey();

        var response = await _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/field",
            new { plugin = "", origin = Origin, fieldPath = "height_max", value = 0.75 });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    /// <summary>
    /// The write path above is the <i>only</i> one: <c>/records/{formKey}</c> itself serves a read
    /// and nothing else, so an agent cannot mutate a record by PUTting the route it read from.
    ///
    /// <para>Asserted against the served OpenAPI document — the exact artifact
    /// <c>modbench/src/medit/generated/api.ts</c> is generated from, so "absent here" is what makes
    /// the frontend unable to call it at all. The positive control matters as much as the absence:
    /// an emptiness assertion alone passes just as happily against a typo'd JSON pointer or a host
    /// that mapped no endpoint, so the surviving read verb is asserted through the identical
    /// lookup.</para>
    /// </summary>
    [Fact]
    public async Task OpenApiDocument_RecordRoute_OffersNoMutatingVerb()
    {
        var body = await _client.GetStringAsync("/swagger/v1/swagger.json");
        var root = JsonDocument.Parse(body).RootElement;
        var operations = root.GetProperty("paths").GetProperty("/records/{formKey}")
            .EnumerateObject().Select(p => p.Name).ToList();

        Assert.Contains("get", operations);
        Assert.Equal([], operations.Where(verb => verb is "patch" or "post" or "put" or "delete").ToArray());
    }
}
