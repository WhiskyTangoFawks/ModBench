using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Traces;

/// <summary>create-plugin: mEdit writes the new plugin into the mod the user picked and answers
/// applied or refusal; the load order learns of it through the watch, never from this reply.</summary>
[Collection(WebHostCollection.Name)]
public sealed class CreatePluginTraceTests : HostedTests
{
    private const string Origin = "PickedMod";

    private async Task<ScatteredFixtureData> Loaded()
    {
        var fx = new PluginFixtureBuilder("trace-create-plugin")
            .WithPlugin("Existing.esp", mod => mod.Npcs.AddNew("ExistingNpc"), origin: Origin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        return fx;
    }

    private static Task<HttpResponseMessage> Create(HttpClient client, string name, string path) =>
        client.PostAsJsonAsync("/plugins/create", new { name, path, origin = Origin });

    [Fact]
    public async Task CreatingAPluginInAMod_AnswersWithThePluginItCreated()
    {
        var fx = Owned(await Loaded());

        var created = await Create(Client, "Created.esp", OtherTool.ModFolderOf(fx, Origin));

        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var body = await created.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Created.esp", body.GetProperty("name").GetString());
        Assert.Equal(Origin, body.GetProperty("origin").GetString());
    }

    [Fact]
    public async Task CreatingAPluginOverAFileAlreadyThere_IsRefused()
    {
        var fx = Owned(await Loaded());
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        OtherTool.WritesTheFile(Path.Combine(modFolder, "Occupied.esp"), "not a plugin");

        var created = await Create(Client, "Occupied.esp", modFolder);

        Assert.Equal(HttpStatusCode.Conflict, created.StatusCode);
    }

    [Fact]
    public async Task CreatingAPluginWithNoLoadOrderHeld_IsRefused()
    {
        using var app = new MEditHost();
        using var client = app.CreateClient();

        var created = await Create(client, "Homeless.esp", Path.Combine(Path.GetTempPath(), "nowhere"));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, created.StatusCode);
    }
}
