using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>Renumbers a record fresh off <c>CreateRecord</c>, still working-tree-only
/// <c>Added</c>: that is the shape that reproduces the stale-record bug; an already committed
/// record would not exercise it.</summary>
[Collection(ApiTestCollection.Name)]
public sealed class RenumberApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private const string Origin = "EditableMod";
    private const string Plugin = "Editable.esp";

    private static ScatteredFixtureData BuildOneModOnePlugin() =>
        new PluginFixtureBuilder("api-renumber")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew("ApiNpc"), origin: Origin)
            .BuildScattered();

    private async Task LoadAndTrack(ScatteredFixtureData fx)
    {
        var load = await _client.PutAsJsonAsync("/load-order", new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = fx.Plugins.Where(p => p.Origin == Origin)
                .Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();
        (await _client.PostAsJsonAsync("/plugins/track", new { origin = Origin, preset = "Edits" }))
            .EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task RenumberRecord_OnANeverCommittedRecord_DropsTheOldFormKeyAtTheWire()
    {
        using var fx = BuildOneModOnePlugin();
        await LoadAndTrack(fx);

        var created = await _client.PostAsJsonAsync($"/plugins/{Plugin}/records", new
        {
            origin = Origin,
            recordType = "npc_",
            editorId = "BrandNew",
            formKey = (string?)null,
        });
        created.EnsureSuccessStatusCode();
        var oldFormKey = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("formKey").GetString()!;

        var renumbered = await _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(oldFormKey)}/renumber",
            new { plugin = Plugin, origin = Origin, newFormKey = (string?)null });
        renumbered.EnsureSuccessStatusCode();
        var newFormKey = (await renumbered.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("newFormKey").GetString()!;

        // The old FormKey's point-read refuses rather than serving stale data.
        var oldRead = await _client.GetAsync($"/records/{Uri.EscapeDataString(oldFormKey)}");
        Assert.Equal(HttpStatusCode.NotFound, oldRead.StatusCode);

        // The old FormKey is gone from the plugin's listing, and the new one is present.
        var listing = await _client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&type=npc_");
        var formKeys = listing.GetProperty("items").EnumerateArray()
            .Select(i => i.GetProperty("formKey").GetString()).ToList();
        Assert.DoesNotContain(oldFormKey, formKeys);
        Assert.Contains(newFormKey, formKeys);
    }
}
