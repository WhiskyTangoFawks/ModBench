using System.Net;
using System.Net.Http.Json;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Api;

[Collection(WebHostCollection.Name)]
public sealed class ImmutablePluginApiTests(LoadedApiFixture<ImmutablePluginFixture> loaded) : IClassFixture<LoadedApiFixture<ImmutablePluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;
    private readonly ImmutablePluginFixture _fixture = loaded.Plugin;

    // Every test gets its own destination folder — the fixture (and its DB/load order) is
    // reused across the whole class (IClassFixture), so two tests sharing one destination would
    // make the second observe the first's Track side effect.
    private string ModFolder(string name) => Path.Combine(_fixture.DataFolder, name);

    [Fact]
    public async Task GetPlugins_ImmutablePlugin_HasIsImmutableTrue()
    {
        var plugins = await _client.GetFromJsonAsync<System.Text.Json.JsonElement[]>("/plugins");
        Assert.NotNull(plugins);

        var fo4 = plugins.Single(p =>
            string.Equals(p.GetProperty("name").GetString(),
                ImmutablePluginFixture.ImmutablePluginName,
                StringComparison.OrdinalIgnoreCase));

        Assert.True(fo4.GetProperty("isImmutable").GetBoolean());
    }

    // The response says what the gesture wrote and registered — the Index has never held this copy,
    // so nothing here is a plugin row.
    [Fact]
    public async Task CreatePlugin_CreatesTheFileAndAnswersWithTheRegisteredCopy()
    {
        var modFolder = ModFolder("NewModMod");
        var resp = await _client.PostAsJsonAsync("/plugins/create", new { name = "NewMod.esp", path = modFolder, origin = "NewModMod" });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var plugin = await resp.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        Assert.Equal("NewMod.esp", plugin.GetProperty("name").GetString());
        Assert.Equal("NewModMod", plugin.GetProperty("origin").GetString());
        Assert.Equal(Path.Combine(modFolder, "NewMod.esp"), plugin.GetProperty("path").GetString());

        Assert.True(File.Exists(Path.Combine(modFolder, "NewMod.esp")));
    }

    // ADR-0015 invariants 1 and 2: the create gesture's own Apply already names the created copy,
    // so it reaches the Index through that same snapshot change — no later PUT is the door.
    [Fact]
    public async Task CreatePlugin_IsQueryable_OnceItsOwnSnapshotReachesTheIndex()
    {
        var modFolder = ModFolder("QueryableMod");
        var created = await _client.PostAsJsonAsync("/plugins/create", new { name = "Queryable.esp", path = modFolder, origin = "QueryableMod" });
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var version = (await created.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>()).GetProperty("version").GetInt64();

        await _client.AwaitTerminalLoadOrderStatus(version);
        Assert.Contains(await Listed(), name => name == "Queryable.esp");
    }

    private async Task<IReadOnlyList<string>> Listed()
    {
        var plugins = await _client.GetFromJsonAsync<System.Text.Json.JsonElement[]>("/plugins");
        Assert.NotNull(plugins);
        return [.. plugins.Select(p => p.GetProperty("name").GetString()
            ?? throw new InvalidOperationException("Expected each listed plugin to carry a name."))];
    }

    [Fact]
    public async Task CreatePlugin_DuplicateName_Returns409()
    {
        var modFolder = ModFolder("DupModMod");
        var resp1 = await _client.PostAsJsonAsync("/plugins/create", new { name = "DupMod.esp", path = modFolder, origin = "DupModMod" });
        Assert.Equal(HttpStatusCode.OK, resp1.StatusCode);

        var resp2 = await _client.PostAsJsonAsync("/plugins/create", new { name = "DupMod.esp", path = modFolder, origin = "DupModMod" });
        Assert.Equal(HttpStatusCode.Conflict, resp2.StatusCode);
    }

    [Fact]
    public async Task CreatePlugin_InvalidExtension_Returns400()
    {
        var resp = await _client.PostAsJsonAsync("/plugins/create", new { name = "BadMod.txt", path = ModFolder("BadModMod"), origin = "BadModMod" });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task CreatePlugin_MissingPathOrOrigin_Returns400()
    {
        var resp = await _client.PostAsJsonAsync("/plugins/create", new { name = "NoPath.esp" });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    // Creating into an untracked destination Tracks it as part of the same gesture — a
    // created plugin must be editable immediately, and editing requires tracking (ADR-0007).
    [Fact]
    public async Task CreatePlugin_UntrackedDestination_TracksIt()
    {
        var modFolder = ModFolder("FreshlyTrackedMod");

        var resp = await _client.PostAsJsonAsync("/plugins/create", new { name = "Tracked.esp", path = modFolder, origin = "FreshlyTrackedMod" });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.True(SourceRepository.IsTracked(modFolder));
    }

    // The rival here is Track's own refusal to re-track (SourceAlreadyTrackedException): a naive
    // "always Track on create" would 409 on this second plugin rather than silently reusing the
    // existing repo.
    [Fact]
    public async Task CreatePlugin_AlreadyTrackedDestination_DoesNotReTrack()
    {
        var modFolder = ModFolder("AlreadyTrackedMod");
        var first = await _client.PostAsJsonAsync("/plugins/create", new { name = "First.esp", path = modFolder, origin = "AlreadyTrackedMod" });
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.True(SourceRepository.IsTracked(modFolder));

        var gitDir = Path.Combine(modFolder, ".git");
        var commitsBefore = GitProbe.Run(gitDir, modFolder, "rev-list", "--count", "main");

        var second = await _client.PostAsJsonAsync("/plugins/create", new { name = "Second.esp", path = modFolder, origin = "AlreadyTrackedMod" });

        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var commitsAfter = GitProbe.Run(gitDir, modFolder, "rev-list", "--count", "main");
        Assert.Equal(commitsBefore, commitsAfter);
    }
}
