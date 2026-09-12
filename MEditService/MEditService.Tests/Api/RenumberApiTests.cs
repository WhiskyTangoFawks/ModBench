using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.SourceRepo;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>Renumbers a record fresh off <c>CreateRecord</c>, still working-tree-only
/// <c>Added</c>: that is the shape that reproduces the stale-record bug; an already committed
/// record would not exercise it.</summary>
[Collection(WebHostCollection.Name)]
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

        var beforeCreate = await _client.GetFromJsonAsync<long>("/load-order/sequence");
        var created = await _client.PostAsJsonAsync($"/plugins/{Plugin}/records", new
        {
            origin = Origin,
            recordType = "npc_",
            editorId = "BrandNew",
            formKey = (string?)null,
        });
        created.EnsureSuccessStatusCode();
        var oldFormKey = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("formKey").GetString()!;

        // ADR-0014: the create wrote the source tree and returned; the renumber below resolves its
        // target through the Index, so it waits for the Source watcher's projection of that write.
        Assert.True(await ProjectionLanded(beforeCreate), "the created record never reached the index");

        var beforeRenumber = await _client.GetFromJsonAsync<long>("/load-order/sequence");
        var renumbered = await _client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(oldFormKey)}/renumber",
            new { plugin = Plugin, origin = Origin, newFormKey = (string?)null });
        renumbered.EnsureSuccessStatusCode();
        var newFormKey = (await renumbered.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("newFormKey").GetString()!;

        // ADR-0014: the renumber's create, delete and cascade settle as one batch and that batch is
        // one advance, so one await is the whole wait — no poll for an end state.
        Assert.True(await ProjectionLanded(beforeRenumber), "the renumbered record never reached the index");

        // The old FormKey's point-read refuses rather than serving stale data.
        var stale = await _client.GetAsync($"/records/{Uri.EscapeDataString(oldFormKey)}");
        Assert.Equal(HttpStatusCode.NotFound, stale.StatusCode);

        // The old FormKey is gone from the plugin's listing, and the new one is present.
        var formKeys = await NpcFormKeys();
        Assert.DoesNotContain(oldFormKey, formKeys);
        Assert.Contains(newFormKey, formKeys);
    }

    // The debounce is 300 ms in the composition root, so the bound is generous; a sleep would be a
    // guess either way.
    private async Task<bool> ProjectionLanded(long before)
    {
        var response = await _client.GetAsync(
            new Uri($"/load-order/sequence/await?atLeast={before + 1}&timeoutMs=20000", UriKind.Relative));
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("reached").GetBoolean();
    }

    private async Task<List<string>> NpcFormKeys()
    {
        var listing = await _client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&type=npc_");
        return [.. listing.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("formKey").GetString()!)];
    }
}
