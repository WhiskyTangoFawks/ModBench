using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>"Typed" is the load-bearing word: an agent must branch on which refusal it got without
/// matching on prose, so the refusal travels as a ProblemDetails extension (ADR-0019).</summary>
[Collection(WebHostCollection.Name)]
public sealed class EditRecordApiTests(LoadedApiFixture<TestPluginFixture> loaded)
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
        var load = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Where(p => p.Origin == Origin)
                .Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();
    }

    private async Task<string> FirstNpcFormKey()
    {
        var records = await _client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&type=npc_");
        return records.GetProperty("items")[0].GetProperty("formKey").GetString()
            ?? throw new InvalidOperationException("Expected the first npc_ record to carry a formKey.");
    }

    // The one envelope: an operation, a path of hops and a value (ADR-0005).
    private Task<HttpResponseMessage> PostEdit(string formKey, string member, object value) =>
        _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/edit",
            new { plugin = Plugin, origin = Origin, op = "set", path = new[] { new { kind = "member", name = member } }, value });

    [Fact]
    public async Task EditRecord_OnATrackedPlugin_LandsAsAWorkingTreeChange()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx);
        var modFolder = PathShape.DirectoryOf(fx.Plugins.Single(p => p.Origin == Origin).Path);
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" })).EnsureSuccessStatusCode();

        var formKey = await FirstNpcFormKey();
        var response = await PostEdit(formKey, "HeightMax", 0.75);

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
    public async Task EditRecord_OnATrackedPlugin_IsVisibleToTheNextRead()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx);
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" })).EnsureSuccessStatusCode();

        var formKey = await FirstNpcFormKey();
        var before = await _client.GetFromJsonAsync<long>("/load-order/sequence");
        (await PostEdit(formKey, "HeightMax", 0.75)).EnsureSuccessStatusCode();

        // ADR-0015 invariant 3: read-your-writes belongs to the read side. The write leaves the
        // edit for the Source watcher to project; the caller awaits the sequence before it reads.
        var awaited = await _client.GetAsync(
            new Uri($"/load-order/sequence/await?atLeast={before + 1}&timeoutMs=15000", UriKind.Relative));
        awaited.EnsureSuccessStatusCode();
        Assert.True((await awaited.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("reached").GetBoolean());

        var detail = await _client.GetFromJsonAsync<JsonElement>($"/records/{Uri.EscapeDataString(formKey)}");
        var field = detail.GetProperty("fields").EnumerateArray()
            .Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == "HeightMax");
        Assert.Equal(0.75, field.GetProperty("value").GetDouble(), 3);
    }

    [Fact]
    public async Task EditRecord_OnAnUntrackedPlugin_IsRefusedWithATypedRefusal()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx); // deliberately not tracked
        var formKey = await FirstNpcFormKey();

        var response = await PostEdit(formKey, "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        // The discriminator an agent branches on, beside the prose a human reads.
        Assert.Equal("PluginNotTracked", problem.GetProperty("refusal").GetString());
        Assert.Contains("Track", problem.GetProperty("detail").GetString()
            ?? throw new InvalidOperationException("Expected the refusal problem to carry a detail message."), StringComparison.Ordinal);
    }

    // The envelope itself could not be read as a write: malformed, so a 400 that still names the
    // refusal an agent branches on.
    [Fact]
    public async Task EditRecord_WithAnUnknownOperation_Is400_WithItsOwnRefusal()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx);
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" })).EnsureSuccessStatusCode();
        var formKey = await FirstNpcFormKey();

        var response = await _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/edit",
            new { plugin = Plugin, origin = Origin, op = "frobnicate", path = new[] { new { kind = "member", name = "HeightMax" } }, value = 1 });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("InvalidEnvelope", problem.GetProperty("refusal").GetString());
        Assert.Equal("HeightMax", problem.GetProperty("path").GetString());
    }

    [Fact]
    public async Task EditRecord_WithAnUnknownField_Is404_WithItsOwnRefusal()
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
    public async Task EditRecord_WhenTheSourceFileHasBeenReplacedByADirectory_IsAShapedProblem_NotAnUnhandled500()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx);
        var modFolder = PathShape.DirectoryOf(fx.Plugins.Single(p => p.Origin == Origin).Path);
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" })).EnsureSuccessStatusCode();
        var formKey = await FirstNpcFormKey();

        // Something outside Modbench replaced this record's source file with a directory. Any I/O
        // failure would do; this one needs no privileges and is deterministic.
        var records = await _client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&type=npc_");
        // Asked of the repository rather than hand-reconstructed (Spriggit-flat layout): the path
        // needs an order index this test has no reason to track. "ApiNpc" is BuildOneModOnePlugin's
        // own literal EditorID above.
        var sourcePath = SourceDocumentPath.Of(
            modFolder, Plugin, "npc_", formKey, "ApiNpc", GameRelease.Fallout4);
        Assert.True(File.Exists(sourcePath), $"expected a source file at {sourcePath}");
        Assert.NotEqual(0, records.GetProperty("total").GetInt32());
        File.Delete(sourcePath);
        Directory.CreateDirectory(sourcePath);

        var response = await PostEdit(formKey, "HeightMax", 0.75);

        // A shaped ProblemDetails, not an empty 500. The tree is the only thing asked, so a document
        // that cannot be read is a record the plugin does not hold (ADR-0015 invariant 5).
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(string.IsNullOrWhiteSpace(problem.GetProperty("detail").GetString()));
    }

    [Fact]
    public async Task EditRecord_WithoutAPlugin_Is400()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx);
        var formKey = await FirstNpcFormKey();

        var response = await _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/edit",
            new { plugin = "", origin = Origin, fieldPath = "HeightMax", value = 0.75 });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // Asserted against the served OpenAPI document because that is the artifact the frontend client
    // is generated from, so absent here is what makes the verb uncallable.
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
