using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class CreateRecordApiTests : HostedTests
{
    private const string Plugin = "Held.esp";
    private const string Origin = "HeldMod";

    private string _worldspace = string.Empty;

    private async Task<ScatteredFixtureData> Loaded()
    {
        var fx = Owned(new PluginFixtureBuilder("api-create-record")
            .WithPlugin(Plugin, mod =>
            {
                mod.Npcs.AddNew("HeldNpc");
                _worldspace = mod.Worldspaces.AddNew("HeldWorld").FormKey.ToString();
            }, origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsCompiledPlugin(Plugin);
        return fx;
    }

    private Task<HttpResponseMessage> Create(string recordType, string? container = null, object? position = null) =>
        Client.CreateRecord(Plugin, Origin, recordType, container, position);

    [Fact]
    public async Task CreatingARecord_InACompiledPlugin_AnswersTheNewFormKey()
    {
        var fx = await Loaded();

        var response = await Create("npc_");

        response.EnsureSuccessStatusCode();
        var formKey = (await response.Body()).GetProperty("formKey").GetString().Require();
        Assert.EndsWith(":" + Plugin, formKey, StringComparison.Ordinal);
        await Client.NextSnapshot(fx);
        await Wire.Eventually(
            async () => (await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&origin={Origin}&type=npc_"))
                .GetProperty("items").EnumerateArray().Any(r => r.GetProperty("formKey").GetString() == formKey),
            "the created record to be read");
    }

    [Fact]
    public async Task CreatingARecord_GivenTheUnsavedTextOfTheHeader_TakesTheNextObjectIdItHolds()
    {
        var fx = await Loaded();
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single().Path).Require();
        var headerFile = Path.Combine(modFolder, "plugin-source", Plugin, $"000000_{Plugin}.json");
        var unsavedHeader = Encoding.UTF8.GetString(HeaderDocument.WithNextObjectId(await File.ReadAllBytesAsync(headerFile), GameRelease.Fallout4, 0xA00));

        await Client.HandUnsaved((headerFile, unsavedHeader));

        var response = await Client.CreateRecord(Plugin, Origin, "npc_");

        response.EnsureSuccessStatusCode();
        Assert.Equal("000A00:" + Plugin, (await response.Body()).GetProperty("formKey").GetString());
    }

    [Fact]
    public async Task CreatingARecord_WithNoRecordType_Is400()
    {
        await Loaded();

        Assert.Equal(HttpStatusCode.BadRequest, (await Create(string.Empty)).StatusCode);
    }

    [Fact]
    public async Task CreatingACell_InAWorldspace_LandsItAtTheGridPositionAsked()
    {
        var fx = await Loaded();

        var response = await Create("cell", _worldspace, new { x = 1, y = -2 });

        response.EnsureSuccessStatusCode();
        var formKey = (await response.Body()).GetProperty("formKey").GetString().Require();
        await Client.NextSnapshot(fx);
        await Wire.Eventually(async () => await CellOfTheWorldspace(formKey) is not null, "the created cell to be read");
        var cell = Assert.NotNull(await CellOfTheWorldspace(formKey));
        Assert.Equal((1, -2), (cell.GetProperty("cellX").GetInt32(), cell.GetProperty("cellY").GetInt32()));
    }

    private async Task<JsonElement?> CellOfTheWorldspace(string formKey)
    {
        var response = await Client.GetAsync(new Uri(
            $"/plugins/{Plugin}/worldspaces/{Uri.EscapeDataString(_worldspace)}/blocks?origin={Origin}", UriKind.Relative));
        if (!response.IsSuccessStatusCode) return null;
        return (await response.Body()).GetProperty("blocks").EnumerateArray()
            .SelectMany(block => block.GetProperty("subBlocks").EnumerateArray())
            .SelectMany(subBlock => subBlock.GetProperty("cells").EnumerateArray())
            .Cast<JsonElement?>()
            .SingleOrDefault(c => c?.GetProperty("formKey").GetString() == formKey);
    }
}
