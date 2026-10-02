using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Api;

// ADR-0012 through the real load path, so bugs at the joins between phases are reachable. Both
// plugins need real mod-folder origins: ColumnKey.Of elides the reserved DataDirectory one, so a
// default-origin fixture passes either way.
public sealed class DuplicateFilenameLoadOrderApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    // Both NPCs land on the same FormKey (each plugin runs its own NextFormID sequence from the
    // same ModKey), which makes this a delta comparison rather than two unrelated files.
    private static ScatteredFixtureData BuildTwoPlugins() =>
        new PluginFixtureBuilder("api-duplicate-filename")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModB").Name = "NameFromModB", origin: "ModB")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModA").Name = "NameFromModA", origin: "ModA")
            // An ordinary editable plugin mastering Shared.esp, so a copy-as-override out of
            // either column has somewhere legitimate to land.
            .WithPlugin("Target.esp", (mod, _) =>
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Shared.esp") }),
                origin: "TargetMod")
            .BuildScattered();

    private async Task PutBothPlugins(ScatteredFixtureData fx, string winner = "ModA")
    {
        // ADR-0013: both plugins travel in the one snapshot, the overridden one at the same slot;
        // only the winning, enabled, listed one is active.
        var plugins = fx.Plugins.Select(p => p.Name == "Shared.esp" ? p with { Winning = p.Origin == winner } : p).ToList();

        var put = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = plugins.Select(p => new { p.Name, p.Path, p.Origin }),
            active = SnapshotPlugins.Active(plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(plugins),
            gameRelease = "Fallout4",
        });
        put.EnsureSuccessStatusCode();
    }

    // A load order keyed by filename alone reports the right origin with the other plugin's
    // content, so each plugin is read while it wins and its own records must come back.
    [Theory]
    [InlineData("ModA", "FromModA")]
    [InlineData("ModB", "FromModB")]
    public async Task EachPlugin_ReadsItsOwnRecordsWhileItWins(string winner, string editorId)
    {
        using var fx = BuildTwoPlugins();
        await PutBothPlugins(fx);
        await PutBothPlugins(fx, winner);

        var records = await _client.GetFromJsonAsync<JsonElement>("/records?type=npc_&limit=50");
        var shared = Assert.Single(records.GetProperty("items").EnumerateArray(), r => r.GetProperty("plugin").GetString() == "Shared.esp");

        Assert.Equal(winner, DocumentNodes.StringValueOf(shared.GetProperty("origin")));
        Assert.Equal(editorId, shared.GetProperty("editorId").GetString());
    }

    // The tree row names the plugin it stands for, since a filename alone cannot identify it: the
    // overridden plugin answers nothing, never the winning plugin's records.
    [Fact]
    public async Task BrowsingByOrigin_ReturnsThatPluginsOwnRecordsAndCounts()
    {
        using var fx = BuildTwoPlugins();
        await PutBothPlugins(fx);
        Assert.Empty(await NpcEditorIds("ModB"));

        await PutBothPlugins(fx, winner: "ModB");

        Assert.Equal(["FromModB"], await NpcEditorIds("ModB"));
        var types = await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/record-types?origin=ModB");
        Assert.Equal(1, types.EnumerateArray().Single(t => t.GetProperty("type").GetString() == "npc_").GetProperty("count").GetInt32());
    }

    private async Task<List<string?>> NpcEditorIds(string origin) =>
        [.. (await _client.GetFromJsonAsync<JsonElement>($"/records?plugin=Shared.esp&origin={origin}&type=npc_&limit=10"))
            .GetProperty("items").EnumerateArray().Select(r => r.GetProperty("editorId").GetString())];

    // ADR-0012 invariant 1: a plugin filter with no origin would match every plugin sharing that
    // filename, so both routes refuse rather than picking one of the two plugins for it.
    [Fact]
    public async Task BrowsingByPluginWithoutOrigin_ReturnsBadRequest()
    {
        using var fx = BuildTwoPlugins();
        await PutBothPlugins(fx);

        var records = await _client.GetAsync("/records?plugin=Shared.esp&type=npc_&limit=10");
        Assert.Equal(HttpStatusCode.BadRequest, records.StatusCode);
        Assert.Equal(
            "Name a plugin with both plugin and origin, or neither to browse every plugin.",
            (await records.Body()).GetProperty("detail").GetString());

        var types = await _client.GetAsync("/plugins/Shared.esp/record-types");
        Assert.Equal(HttpStatusCode.BadRequest, types.StatusCode);
        Assert.Equal("Origin is required.", (await types.Body()).GetProperty("detail").GetString());
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
        // one file named Shared.esp, so the overridden plugin stays indexed but never columns.
        var column = Assert.Single(columns);
        Assert.Equal("ModA", column.Key);
        Assert.Equal("FromModA", column.Value.GetProperty("editorId").GetString());
        Assert.True(column.Value.GetProperty("isWinner").GetBoolean());
        // OnlyOne, not NoConflict: classification sees a single participating plugin, so this record
        // is exactly as unconflicted as a single-plugin record — which is the whole claim, that an
        // overridden plugin changes no classification.
        Assert.Equal("OnlyOne", compare.GetProperty("conflictAll").GetString());
    }
}
