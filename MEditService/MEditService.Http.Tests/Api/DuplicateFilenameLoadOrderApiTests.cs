using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Api;

// ADR-0012 through the real load path, so bugs at the joins between phases are reachable. Both
// plugins need real mod-folder origins: ColumnKey.Of elides the reserved DataDirectory one, so a
// default-origin fixture passes either way.
[Collection(WebHostCollection.Name)]
public sealed class DuplicateFilenameLoadOrderApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    // Both NPCs land on the same FormKey (each plugin runs its own NextFormID sequence from the
    // same ModKey), which makes this a delta comparison rather than two unrelated files.
    private static ScatteredFixtureData BuildTwoPlugins() =>
        new PluginFixtureBuilder("api-duplicate-filename")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModA").Name = "NameFromModA", origin: "ModA")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModB").Name = "NameFromModB", origin: "ModB")
            // An ordinary editable plugin mastering Shared.esp, so a copy-as-override out of
            // either column has somewhere legitimate to land.
            .WithPlugin("Target.esp", (mod, _) =>
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Shared.esp") }),
                origin: "TargetMod")
            .BuildScattered();

    private async Task PutBothPlugins(ScatteredFixtureData fx)
    {
        // ADR-0013: both plugins travel in the one snapshot, ModB as the overridden plugin at the
        // same slot; only the winning, enabled, listed one participates.
        var winner = fx.Plugins.Single(p => p.Origin == "ModA");
        var plugins = fx.Plugins.Select(p => p.Origin == "ModB"
            ? p with { Slot = winner.Slot, Winning = false }
            : p);

        var put = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        });
        put.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task OverriddenPlugin_IsAHeldPluginAlongsideThePluginThatOverridesIt()
    {
        using var fx = BuildTwoPlugins();
        await PutBothPlugins(fx);

        var plugins = await _client.GetFromJsonAsync<JsonElement>("/plugins");
        var origins = plugins.EnumerateArray()
            .Where(p => p.GetProperty("name").GetString() == "Shared.esp")
            .Select(p => p.GetProperty("origin").GetString())
            .ToList();

        Assert.Equal(["ModA", "ModB"], origins);
    }

    [Fact]
    public async Task OverriddenPlugin_IndexesItsOwnRecordsNotTheOtherPlugins()
    {
        using var fx = BuildTwoPlugins();
        await PutBothPlugins(fx);

        // Deliberately unfiltered by plugin: `?plugin=` resolves origin from the filename
        // server-side, so it can only answer for one of two plugins that share a filename.
        var records = await _client.GetFromJsonAsync<JsonElement>("/records?type=npc_&limit=50");
        var byOrigin = records.GetProperty("items").EnumerateArray()
            .Where(r => r.GetProperty("plugin").GetString() == "Shared.esp")
            .ToDictionary(r => DocumentNodes.StringValueOf(r.GetProperty("origin")), r => r.GetProperty("editorId").GetString());

        // A load order keyed by filename alone reports two rows with the right origins and the
        // same content, so the failure being pinned is not a missing row.
        Assert.Equal("FromModA", byOrigin["ModA"]);
        Assert.Equal("FromModB", byOrigin["ModB"]);
    }

    [Fact]
    public async Task BrowsingByOrigin_ReturnsThatPluginsOwnRecordsAndCounts()
    {
        using var fx = BuildTwoPlugins();
        await PutBothPlugins(fx);

        // The tree row names the plugin it stands for, since a filename alone cannot identify it.
        var records = await _client.GetFromJsonAsync<JsonElement>("/records?plugin=Shared.esp&origin=ModB&type=npc_&limit=10");
        var editorIds = records.GetProperty("items").EnumerateArray()
            .Select(r => r.GetProperty("editorId").GetString())
            .ToList();
        Assert.Equal(["FromModB"], editorIds);

        var types = await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/record-types?origin=ModB");
        Assert.Equal(1, types.EnumerateArray().Single(t => t.GetProperty("type").GetString() == "npc_").GetProperty("count").GetInt32());
    }

    [Fact]
    public async Task OverriddenPlugin_IsNotACompareColumn()
    {
        using var fx = BuildTwoPlugins();
        await PutBothPlugins(fx);

        var compare = await _client.GetFromJsonAsync<JsonElement>(
            $"/records/{Uri.EscapeDataString("000800:Shared.esp")}/compare");
        var columns = compare.GetProperty("overrides").EnumerateArray()
            .ToDictionary(o => DocumentNodes.StringValueOf(o.GetProperty("origin")), o => o);

        // ADR-0012: the grid is xEdit parity, the in-game resolution stack. The game loads exactly
        // one file named Shared.esp, so the overridden plugin stays indexed and browsable but never
        // columns.
        var column = Assert.Single(columns);
        Assert.Equal("ModA", column.Key);
        Assert.Equal("FromModA", column.Value.GetProperty("editorId").GetString());
        Assert.True(column.Value.GetProperty("isWinner").GetBoolean());
        // OnlyOne, not NoConflict: classification sees a single participating plugin, so this record
        // is exactly as unconflicted as a single-plugin record — which is the whole claim, that an
        // overridden plugin changes no classification.
        Assert.Equal("OnlyOne", compare.GetProperty("conflictAll").GetString());
    }

    [Fact]
    public async Task ASnapshotWithoutTheOverriddenPlugin_LeavesNoRowNoColumnAndNoRecords()
    {
        using var fx = BuildTwoPlugins();
        await PutBothPlugins(fx);

        // ADR-0013: a plugin absent from the snapshot is unregistered, while the plugin that wins is
        // untouched, because a reconcile is not a reload.
        var without = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Where(p => p.Origin != "ModB").Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        });
        without.EnsureSuccessStatusCode();

        var plugins = await _client.GetFromJsonAsync<JsonElement>("/plugins");
        Assert.DoesNotContain(plugins.EnumerateArray(), p => p.GetProperty("origin").GetString() == "ModB");

        var compare = await _client.GetFromJsonAsync<JsonElement>(
            $"/records/{Uri.EscapeDataString("000800:Shared.esp")}/compare");
        Assert.DoesNotContain(compare.GetProperty("overrides").EnumerateArray(),
            o => o.GetProperty("origin").GetString() == "ModB");

        var records = await _client.GetFromJsonAsync<JsonElement>("/records?type=npc_&limit=50");
        Assert.DoesNotContain(records.GetProperty("items").EnumerateArray(),
            r => r.GetProperty("origin").GetString() == "ModB");

        Assert.Contains(plugins.EnumerateArray(), p => p.GetProperty("origin").GetString() == "ModA");
    }

    [Fact]
    public async Task TheSameSnapshotTwice_LeavesOneEntryPerPluginAndAWorkingCompare()
    {
        using var fx = BuildTwoPlugins();
        await PutBothPlugins(fx);
        await PutBothPlugins(fx);

        var plugins = await _client.GetFromJsonAsync<JsonElement>("/plugins");
        Assert.Single(plugins.EnumerateArray(), p => p.GetProperty("origin").GetString() == "ModB");
        Assert.Single(plugins.EnumerateArray(), p => p.GetProperty("origin").GetString() == "ModA");

        // A duplicate entry would make every column-keyed lookup ambiguous — GetCompare builds its
        // masters/participation dictionaries by ColumnKey and would throw on the pair.
        var compare = await _client.GetAsync($"/records/{Uri.EscapeDataString("000800:Shared.esp")}/compare");
        Assert.Equal(HttpStatusCode.OK, compare.StatusCode);
    }

    [Fact]
    public async Task OverriddenPlugin_IsReadOnlyAndOutsideTheLoadOrder()
    {
        using var fx = BuildTwoPlugins();
        await PutBothPlugins(fx);

        var plugins = await _client.GetFromJsonAsync<JsonElement>("/plugins");
        var overridden = plugins.EnumerateArray().Single(p => p.GetProperty("origin").GetString() == "ModB");

        // ADR-0012: read-only, because an edit to a file the game does not load produces no
        // observable change anywhere. ADR-0013: non-participating, so it can never take a winner
        // from the plugin that overrides it.
        Assert.True(overridden.GetProperty("isImmutable").GetBoolean());
        Assert.False(overridden.GetProperty("participates").GetBoolean());
        Assert.False(overridden.GetProperty("inLoadOrder").GetBoolean());
        // It shares the winning plugin's slot — the registration fact a future
        // show-overridden-plugins toggle would render the pair adjacent from (the grid itself
        // excludes it today).
        Assert.Equal(
            plugins.EnumerateArray().Single(p => p.GetProperty("origin").GetString() == "ModA").GetProperty("loadOrderIndex").GetInt32(),
            overridden.GetProperty("loadOrderIndex").GetInt32());
    }
}
