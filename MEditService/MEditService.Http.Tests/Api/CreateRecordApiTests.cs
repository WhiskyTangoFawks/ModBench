using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class CreateRecordApiTests : HostedTests
{
    private const string Plugin = "Held.esp";
    private const string Origin = "HeldMod";

    private async Task<ScatteredFixtureData> Loaded(bool tracked)
    {
        var fx = Owned(new PluginFixtureBuilder("api-create-record")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("HeldNpc"), origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        if (!tracked) return fx;

        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsTracked(Plugin);
        return fx;
    }

    private Task<HttpResponseMessage> Create(string origin, string recordType) =>
        Client.PostAsJsonAsync($"/plugins/{Plugin}/records", new { origin, recordType });

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
}
