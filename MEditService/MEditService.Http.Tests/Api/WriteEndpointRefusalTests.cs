using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class WriteEndpointRefusalTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private const string ReadAndExecuteOnly = "500";
    private const string OwnerFullAccess = "700";

    private const string Origin = "EditableMod";
    private const string Plugin = "Editable.esp";
    private const string DestOrigin = "DestinationMod";
    private const string DestPlugin = "Destination.esp";

    private static ScatteredFixtureData BuildOneModOnePlugin() =>
        new PluginFixtureBuilder("api-write-one")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("ApiNpc"), origin: Origin)
            .BuildScattered();

    private static ScatteredFixtureData BuildSourceAndDestination() =>
        new PluginFixtureBuilder("api-write-two")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("ApiNpc"), origin: Origin)
            .WithPlugin(DestPlugin, mod => mod.Npcs.AddNew("DestNpc"), origin: DestOrigin)
            .BuildScattered();

    private async Task Load(ScatteredFixtureData fx)
    {
        var load = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Select(p => p.Wire),
            active = SnapshotPlugins.Active(fx.Plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(fx.Plugins),
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();
    }

    private async Task Track(string origin) =>
        (await _client.Track(origin)).EnsureSuccessStatusCode();

    private async Task<string> FirstNpcFormKey(string plugin, string origin)
    {
        var records = await _client.GetFromJsonAsync<JsonElement>($"/records?plugin={plugin}&origin={origin}&type=npc_");
        return DocumentNodes.StringValueOf(records.GetProperty("items")[0].GetProperty("formKey"));
    }

    private static string ModFolderOf(ScatteredFixtureData fx, string origin)
    {
        var path = fx.Plugins.Single(p => p.Origin == origin).Path;
        return Path.GetDirectoryName(path)
            ?? throw new InvalidOperationException($"Expected '{path}' to have a parent directory.");
    }

    [Fact]
    public async Task DeletingNoRecordsIsABadRequest()
    {
        var response = await _client.PostAsJsonAsync("/records/delete", new { records = Array.Empty<object>() });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task DeletingARecordWithNoOriginIsABadRequest()
    {
        var response = await _client.PostAsJsonAsync("/records/delete", new
        {
            records = new[] { new { formKey = "000800:Editable.esp", plugin = Plugin, origin = "" } },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("Override")]
    [InlineData("New")]
    public async Task CopyingToAnUnwritableDestinationRefusesTheItemInsteadOfFailingTheRequest(string mode)
    {
        using var fx = BuildSourceAndDestination();
        await Load(fx);
        await Track(DestOrigin);
        var formKey = await FirstNpcFormKey(Plugin, Origin);
        var destModFolder = ModFolderOf(fx, DestOrigin);

        OtherTool.SetsThePermissions(destModFolder, ReadAndExecuteOnly);
        try
        {
            var response = await _client.Copy(formKey, (Plugin, Origin), mode, (DestPlugin, DestOrigin));

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var refused = Assert.Single((await response.Body()).GetProperty("refused").EnumerateArray());
            Assert.Equal("SourceAccessFailed", refused.GetProperty("refusal").GetString());
            Assert.False(string.IsNullOrWhiteSpace(refused.GetProperty("message").GetString()));
        }
        finally
        {
            OtherTool.SetsThePermissions(destModFolder, OwnerFullAccess);
        }
    }

    [Fact]
    public async Task CopyingWithNoDestinationIsABadRequest()
    {
        using var fx = BuildSourceAndDestination();
        await Load(fx);
        var formKey = await FirstNpcFormKey(Plugin, Origin);

        var response = await _client.Copy([(formKey, Plugin, Origin)], "Override", []);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task CopyingAsNewWithReplaceIsABadRequestAndCopiesNothing()
    {
        using var fx = BuildSourceAndDestination();
        await Load(fx);
        await Track(DestOrigin);
        var formKey = await FirstNpcFormKey(Plugin, Origin);
        var destination = TreeSnapshot.Of(ModFolderOf(fx, DestOrigin));

        var response = await _client.Copy(formKey, (Plugin, Origin), "New", (DestPlugin, DestOrigin), replace: true);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(destination, TreeSnapshot.Of(ModFolderOf(fx, DestOrigin)));
    }
}
