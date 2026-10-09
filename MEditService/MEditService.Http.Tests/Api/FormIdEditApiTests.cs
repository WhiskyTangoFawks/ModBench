using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class FormIdEditApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private const string Origin = "EditableMod";
    private const string Plugin = "Editable.esp";

    private static ScatteredFixtureData BuildOneModOnePlugin() =>
        new PluginFixtureBuilder("api-formid-edit")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("ApiNpc"), origin: Origin)
            .BuildScattered();

    private async Task LoadAndTrack(ScatteredFixtureData fx)
    {
        var load = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Where(p => p.Origin == Origin).Select(p => p.Wire),
            active = SnapshotPlugins.Active(fx.Plugins.Where(p => p.Origin == Origin)),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(fx.Plugins.Where(p => p.Origin == Origin)),
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();
        (await _client.Track(Origin)).EnsureSuccessStatusCode();
        await _client.NextSnapshot(fx, Origin);
        await _client.PluginReportsTracked(Plugin);
    }

    [Fact]
    public async Task EditingTheFormId_OfANeverCommittedRecord_DropsTheOldFormKeyAtTheWire()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadAndTrack(fx);

        var created = await _client.CreateRecord(Plugin, Origin, "npc_");
        created.EnsureSuccessStatusCode();
        var oldFormKey = DocumentNodes.StringValueOf((await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("formKey"));

        await _client.NextSnapshot(fx, Origin);
        await Wire.Eventually(
            async () => (await _client.GetAsync(new Uri($"/records/{Uri.EscapeDataString(oldFormKey)}", UriKind.Relative))).IsSuccessStatusCode,
            "the created record reached the index");

        const string newFormKey = "000F00:Editable.esp";
        var beforeEdit = await _client.GetFromJsonAsync<long>("/load-order/sequence");
        using var stream = await _client.NotificationStream();
        var edited = await _client.Edit(oldFormKey, Plugin, Origin, "FormKey", newFormKey);
        edited.EnsureSuccessStatusCode();
        Assert.Equal(newFormKey, DocumentNodes.StringValueOf((await edited.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("newFormKey")));
        await _client.NextSnapshot(fx, Origin);

        var named = (await stream.EventsUntil("rows-changed", e => KeysOf(e).Contains(newFormKey)))
            .SelectMany(KeysOf).ToHashSet(StringComparer.Ordinal);
        Assert.Contains(oldFormKey, named);

        Assert.True(await ProjectionLanded(beforeEdit), "the record under its new FormKey never reached the index");

        var stale = await _client.GetAsync($"/records/{Uri.EscapeDataString(oldFormKey)}");
        Assert.Equal(HttpStatusCode.NotFound, stale.StatusCode);

        var formKeys = await NpcFormKeys();
        Assert.DoesNotContain(oldFormKey, formKeys);
        Assert.Contains(newFormKey, formKeys);
    }

    private const int GenerousTimeoutForValidationOnTheServicesOwnThreadMs = 20000;

    private async Task<bool> ProjectionLanded(long before)
    {
        var response = await _client.GetAsync(
            new Uri($"/load-order/sequence/await?atLeast={before + 1}&timeoutMs={GenerousTimeoutForValidationOnTheServicesOwnThreadMs}", UriKind.Relative));
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("reached").GetBoolean();
    }

    private static string[] KeysOf(JsonElement rowsChanged) =>
        [.. rowsChanged.GetProperty("keys").EnumerateArray().Select(k => k.GetString().Require())];

    private async Task<List<string>> NpcFormKeys()
    {
        var listing = await _client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&origin={Origin}&type=npc_");
        return [.. listing.GetProperty("items").EnumerateArray().Select(i => DocumentNodes.StringValueOf(i.GetProperty("formKey")))];
    }
}
