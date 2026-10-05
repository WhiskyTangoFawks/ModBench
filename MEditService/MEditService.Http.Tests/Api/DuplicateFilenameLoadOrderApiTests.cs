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

public sealed class DuplicateFilenameLoadOrderApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private static ScatteredFixtureData BuildTwoPluginsSharingAFilenameAndAFormKeyUnderRealModFolderOrigins() =>
        new PluginFixtureBuilder("api-duplicate-filename")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModB").Name = "NameFromModB", origin: "ModB")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModA").Name = "NameFromModA", origin: "ModA")
            .WithPlugin("Target.esp", (mod, _) =>
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Shared.esp") }),
                origin: "TargetMod")
            .BuildScattered();

    private async Task PutBothPlugins(ScatteredFixtureData fx, string winner = "ModA")
    {
        var plugins = fx.Plugins.Select(p => p.Name == "Shared.esp" ? p with { Winning = p.Origin == winner } : p).ToList();

        var put = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = plugins.Select(p => p.Wire),
            active = SnapshotPlugins.Active(plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(plugins),
            gameRelease = "Fallout4",
        });
        put.EnsureSuccessStatusCode();
    }

    [Theory]
    [InlineData("ModA", "FromModA")]
    [InlineData("ModB", "FromModB")]
    public async Task EachPlugin_ReadsItsOwnRecordsWhileItWins(string winner, string editorId)
    {
        using var fx = BuildTwoPluginsSharingAFilenameAndAFormKeyUnderRealModFolderOrigins();
        await PutBothPlugins(fx);
        await PutBothPlugins(fx, winner);

        var records = await _client.GetFromJsonAsync<JsonElement>("/records?type=npc_&limit=50");
        var shared = Assert.Single(records.GetProperty("items").EnumerateArray(), r => r.GetProperty("plugin").GetString() == "Shared.esp");

        Assert.Equal(winner, DocumentNodes.StringValueOf(shared.GetProperty("origin")));
        Assert.Equal(editorId, shared.GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task BrowsingByOrigin_ReturnsThatPluginsOwnRecordsAndCounts()
    {
        using var fx = BuildTwoPluginsSharingAFilenameAndAFormKeyUnderRealModFolderOrigins();
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

    [Fact]
    public async Task BrowsingByPluginWithoutOrigin_ReturnsBadRequest()
    {
        using var fx = BuildTwoPluginsSharingAFilenameAndAFormKeyUnderRealModFolderOrigins();
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
    public async Task OverriddenPlugin_IsNotACompareColumn_AndTheRecordClassifiesOnlyOne()
    {
        using var fx = BuildTwoPluginsSharingAFilenameAndAFormKeyUnderRealModFolderOrigins();
        await PutBothPlugins(fx);

        var compare = await _client.GetFromJsonAsync<JsonElement>(
            $"/records/{Uri.EscapeDataString("000800:Shared.esp")}/compare");
        var columns = compare.GetProperty("overrides").EnumerateArray()
            .ToDictionary(o => DocumentNodes.StringValueOf(o.GetProperty("origin")), o => o);

        var column = Assert.Single(columns);
        Assert.Equal("ModA", column.Key);
        Assert.Equal("FromModA", column.Value.GetProperty("editorId").GetString());
        Assert.True(column.Value.GetProperty("isWinner").GetBoolean());
        Assert.Equal("OnlyOne", compare.GetProperty("conflictAll").GetString());
    }
}
