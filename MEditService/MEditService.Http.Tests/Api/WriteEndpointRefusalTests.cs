using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class WriteEndpointRefusalTests : HostedTests
{
    private const string Origin = "EditableMod";
    private const string Plugin = "Editable.esp";
    private const string DestOrigin = "DestinationMod";
    private const string DestPlugin = "Destination.esp";

    private async Task<string> LoadedSourceAndDestinationsFirstNpc()
    {
        var fx = Owned(new PluginFixtureBuilder("api-write-two")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("ApiNpc"), origin: Origin)
            .WithPlugin(DestPlugin, mod => mod.Npcs.AddNew("DestNpc"), origin: DestOrigin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        return await Client.FirstFormKey(Plugin, Origin);
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("[{\"formKey\": \"000800:Editable.esp\", \"plugin\": {\"name\": \"Editable.esp\", \"origin\": \"\"}}]")]
    public async Task DeletingNoRecords_OrARecordWithNoOrigin_IsABadRequest(string records)
    {
        var response = await Client.PostJson("/records/delete-changes", $"{{\"records\": {records}}}");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task CopyingWithNoDestinationIsABadRequest()
    {
        var formKey = await LoadedSourceAndDestinationsFirstNpc();

        var response = await Client.Copy([(formKey, Plugin, Origin)], "Override", []);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task CopyingAsNewWithReplaceIsABadRequest()
    {
        var formKey = await LoadedSourceAndDestinationsFirstNpc();

        var response = await Client.Copy(formKey, (Plugin, Origin), "New", (DestPlugin, DestOrigin), replace: true);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
