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

    private async Task<ScatteredFixtureData> Loaded(bool tracked)
    {
        var fx = Owned(new PluginFixtureBuilder("api-create-record")
            .WithPlugin(Plugin, mod =>
            {
                mod.Npcs.AddNew("HeldNpc");
                _worldspace = mod.Worldspaces.AddNew("HeldWorld").FormKey.ToString();
            }, origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        if (!tracked) return fx;

        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsTracked(Plugin);
        return fx;
    }

    private Task<HttpResponseMessage> Create(string origin, string recordType, string? container = null, object? position = null) =>
        Client.CreateRecord(Plugin, origin, recordType, container, position);

    [Fact]
    public async Task CreatingARecord_InATrackedPlugin_AnswersTheNewFormKey()
    {
        var fx = await Loaded(tracked: true);

        var response = await Create(Origin, "npc_");

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
        var fx = await Loaded(tracked: true);
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single().Path).Require();
        var headerFile = Path.Combine(modFolder, "plugin-source", Plugin, $"000000_{Plugin}.json");
        var unsavedHeader = Encoding.UTF8.GetString(HeaderDocument.WithNextObjectId(await File.ReadAllBytesAsync(headerFile), 0xA00));

        await Client.HandUnsaved((headerFile, unsavedHeader));

        var response = await Client.CreateRecord(Plugin, Origin, "npc_");

        response.EnsureSuccessStatusCode();
        Assert.Equal("000A00:" + Plugin, (await response.Body()).GetProperty("formKey").GetString());
    }

    [Fact]
    public async Task CreatingARecord_WithNoOrigin_Is400()
    {
        await Loaded(tracked: true);

        Assert.Equal(HttpStatusCode.BadRequest, (await Create(string.Empty, "npc_")).StatusCode);
    }

    [Fact]
    public async Task CreatingARecord_WithNoRecordType_Is400()
    {
        await Loaded(tracked: true);

        Assert.Equal(HttpStatusCode.BadRequest, (await Create(Origin, string.Empty)).StatusCode);
    }

    [Fact]
    public async Task CreatingARecord_InAnUntrackedPlugin_Is409()
    {
        await Loaded(tracked: false);

        var response = await Create(Origin, "npc_");

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("PluginNotTracked", (await response.Body()).GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task CreatingARecord_OfATypeThePluginCannotHold_Is422()
    {
        await Loaded(tracked: true);

        var response = await Create(Origin, "nosuch");

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        Assert.Equal("RecordTypeNotFound", (await response.Body()).GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task CreatingACell_InAWorldspace_AnswersTheNewFormKey()
    {
        await Loaded(tracked: true);

        var response = await Create(Origin, "cell", _worldspace, new { x = 1, y = -2 });

        response.EnsureSuccessStatusCode();
        Assert.EndsWith(":" + Plugin, (await response.Body()).GetProperty("formKey").GetString().Require(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task CreatingACell_InAWorldspace_WithOnlyOneCoordinate_Is400()
    {
        await Loaded(tracked: true);

        var response = await Create(Origin, "cell", _worldspace, new { x = 1 });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("InvalidEnvelope", (await response.Body()).GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task CreatingARecord_WithAGridPositionAndNoContainer_Is400()
    {
        await Loaded(tracked: true);

        Assert.Equal(HttpStatusCode.BadRequest, (await Create(Origin, "cell", position: new { x = 0, y = 0 })).StatusCode);
    }

    [Fact]
    public async Task CreatingARecord_InAContainerThePluginLacks_Is404()
    {
        await Loaded(tracked: true);

        var response = await Create(Origin, "refr", "000FFF:" + Plugin);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("RecordNotFound", (await response.Body()).GetProperty("refusal").GetString());
    }
}
