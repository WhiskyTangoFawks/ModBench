using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

[Collection(WebHostCollection.Name)]
public sealed class TrackApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private static ScatteredFixtureData BuildOneModOnePlugin() =>
        new PluginFixtureBuilder("api-track")
            .WithPlugin("Tracked.esp", mod => mod.Npcs.AddNew("SomeNpc"), origin: "TrackedMod")
            .BuildScattered();

    private async Task LoadOnly(ScatteredFixtureData fx, string origin)
    {
        var load = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Where(p => p.Origin == origin)
                .Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task Track_ARealLoadedMod_CreatesTheRepoInItsModFolder()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx, "TrackedMod");
        var modFolder = PathShape.DirectoryOf(fx.Plugins.Single(p => p.Origin == "TrackedMod").Path);

        var response = await _client.PostAsJsonAsync("/plugins/track", new { origin = "TrackedMod", preset = "Edits" });

        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("TrackedMod", body.GetProperty("origin").GetString());
        Assert.True(SourceRepository.IsTracked(modFolder));
    }

    [Fact]
    public async Task Track_WithoutAnOrigin_Is400()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx, "TrackedMod");

        var response = await _client.PostAsJsonAsync("/plugins/track", new { origin = "", preset = "Edits" });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Track_AnOriginNoLoadedPluginHas_Is404()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx, "TrackedMod");

        var response = await _client.PostAsJsonAsync("/plugins/track", new { origin = "NoSuchMod", preset = "Edits" });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Track_ANeverTrackedMod_ThenTrackedAgain_Is409()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadOnly(fx, "TrackedMod");

        var first = await _client.PostAsJsonAsync("/plugins/track", new { origin = "TrackedMod", preset = "Edits" });
        first.EnsureSuccessStatusCode();

        var second = await _client.PostAsJsonAsync("/plugins/track", new { origin = "TrackedMod", preset = "Edits" });

        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
    }

    // ADR-0015 invariant 2: no load order is put between the Track and the edit, so the tracked
    // copy's rows can only have reached the Index through the watch Track's own write armed.
    [Fact]
    public async Task AfterTrack_AHandEditToTheSourceTree_LandsInTheIndex_WithNoReconcile()
    {
        FormKey npc = default;
        using var fx = new PluginFixtureBuilder("api-track-watch")
            .WithPlugin("Watched.esp", mod => npc = mod.Npcs.AddNew("WatchedNpc").FormKey, origin: "WatchedMod")
            .BuildScattered();
        await LoadOnly(fx, "WatchedMod");
        var modFolder = PathShape.DirectoryOf(fx.Plugins.Single(p => p.Origin == "WatchedMod").Path);
        var key = new PluginCopyKey("Watched.esp", "WatchedMod");

        var response = await _client.PostAsJsonAsync("/plugins/track", new { origin = "WatchedMod", preset = "Edits" });
        response.EnsureSuccessStatusCode();
        RenameByHand(modFolder, "Watched.esp", "WatchedNpc", "RenamedByHand");

        Assert.Equal("RenamedByHand", await EditorIdReaches(npc, key, "RenamedByHand"));
    }

    // ADR-0007: the destination is Tracked inside the create gesture, so its watch is armed there
    // too — the mod's own copy answers from source with no load order put after the create.
    [Fact]
    public async Task AfterCreate_AHandEditToTheDestinationsSource_LandsInTheIndex_WithNoReconcile()
    {
        FormKey npc = default;
        using var fx = new PluginFixtureBuilder("api-create-watch")
            .WithPlugin("Held.esp", mod => npc = mod.Npcs.AddNew("HeldNpc").FormKey, origin: "CreatedIntoMod")
            .BuildScattered();
        await LoadOnly(fx, "CreatedIntoMod");
        var modFolder = PathShape.DirectoryOf(fx.Plugins.Single(p => p.Origin == "CreatedIntoMod").Path);
        var key = new PluginCopyKey("Held.esp", "CreatedIntoMod");

        var response = await _client.PostAsJsonAsync(
            "/plugins/create", new { name = "Minted.esp", path = modFolder, origin = "CreatedIntoMod" });
        response.EnsureSuccessStatusCode();
        RenameByHand(modFolder, "Held.esp", "HeldNpc", "RenamedByHand");

        Assert.Equal("RenamedByHand", await EditorIdReaches(npc, key, "RenamedByHand"));
    }

    private static void RenameByHand(string modFolder, string plugin, string editorId, string renamed)
    {
        var document = Directory
            .EnumerateFiles(SourceRepository.RootIn(modFolder, plugin), "*.json", SearchOption.AllDirectories)
            .Single(f => File.ReadAllText(f).Contains($"\"{editorId}\"", StringComparison.Ordinal));
        File.WriteAllText(document,
            File.ReadAllText(document).Replace($"\"{editorId}\"", $"\"{renamed}\"", StringComparison.Ordinal));
    }

    private string? EditorIdOf(FormKey formKey, PluginCopyKey plugin)
    {
        var store = loaded.Services.GetRequiredService<IndexProjector>().Store
            ?? throw new InvalidOperationException("Expected the index projector to already hold a built store.");
        return store.At(RecordRef.Effective).GetDocument(formKey.ToString(), plugin)?.EditorId;
    }

    // Long enough for the settle window the edit opens, and the refresh behind it.
    private async Task<string?> EditorIdReaches(FormKey formKey, PluginCopyKey plugin, string editorId)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(15);
        while (DateTime.UtcNow < deadline && EditorIdOf(formKey, plugin) != editorId)
            await Task.Delay(50);
        return EditorIdOf(formKey, plugin);
    }
}
