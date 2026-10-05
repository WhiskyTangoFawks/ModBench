using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

public sealed class ClearFieldApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private const string Origin = "ClearableMod";
    private const string Plugin = "Clearable.esp";

    [Fact]
    public async Task ASetOfJsonNull_ClearsTheMember()
    {
        using var fx = new PluginFixtureBuilder("api-clear-field")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("ApiNpc"), origin: Origin)
            .BuildScattered();
        var plugins = fx.Plugins.Where(p => p.Origin == Origin);
        (await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = plugins.Select(p => p.Wire),
            active = SnapshotPlugins.Active(plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(plugins),
            gameRelease = "Fallout4",
        })).EnsureSuccessStatusCode();
        (await _client.Track(Origin)).EnsureSuccessStatusCode();
        await _client.NextSnapshot(fx, Origin);
        await _client.PluginReportsTracked(Plugin);
        var created = await _client.PostAsJsonAsync($"/plugins/{Plugin}/records", new
        {
            origin = Origin,
            recordType = "npc_",
            editorId = "ToClear",
            formKey = (string?)null,
        });
        created.EnsureSuccessStatusCode();
        var formKey = DocumentNodes.StringValueOf((await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("formKey"));
        await _client.NextSnapshot(fx, Origin);
        await Wire.Eventually(
            async () => (await _client.GetAsync(new Uri($"/records/{Uri.EscapeDataString(formKey)}", UriKind.Relative))).IsSuccessStatusCode,
            "the created record reached the index");

        var url = new Uri($"/records/{Uri.EscapeDataString(formKey)}", UriKind.Relative);
        async Task<bool> HoldsHeight() => (await _client.GetStringAsync(url)).Contains("0.75", StringComparison.Ordinal);

        (await _client.Edit(formKey, Plugin, Origin, "HeightMax", 0.75)).EnsureSuccessStatusCode();
        await _client.NextSnapshot(fx, Origin);
        await Wire.Eventually(HoldsHeight, "the set reached the index");

        var cleared = await _client.Edit(formKey, Plugin, Origin, "HeightMax", JsonDocument.Parse("null").RootElement);
        Assert.True(cleared.IsSuccessStatusCode, await cleared.Content.ReadAsStringAsync());
        await _client.NextSnapshot(fx, Origin);

        await Wire.Eventually(async () => !await HoldsHeight(), "the clear reached the index");
    }
}
