using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>
/// #573 AC1/AC2 at the actual wire: after renumbering a record, <c>GET /records?plugin=...</c> must
/// no longer list the old FormKey and <c>GET /records/{oldFormKey}</c> must 404 rather than keep
/// serving a fully-populated, stale record. <see cref="RecordEditServiceRenumberRecordTests"/> pins
/// the same fact at the <c>IRecordReads</c> layer (the seam <c>RecordQueryService</c> sits on); this
/// is the one round-trip through the real endpoints, the same <see cref="LoadedApiFixture{TPlugin}"/>
/// harness <c>EditFieldApiTests</c> already uses.
///
/// <para>Renumbers a record fresh off <c>CreateRecord</c> (never committed, still working-tree-only
/// <c>Added</c>) rather than one of the fixture's own pre-committed NPCs — that shape is what
/// reproduced #573 (the original report's own <c>workingTreeState: "Added"</c> old FormKey);
/// renumbering an already-committed record wouldn't have exercised the bug at all.</para>
/// </summary>
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

        // AC2: the old FormKey's point-read refuses rather than serving stale data.
        var oldRead = await _client.GetAsync($"/records/{Uri.EscapeDataString(oldFormKey)}");
        Assert.Equal(HttpStatusCode.NotFound, oldRead.StatusCode);

        // AC1: the old FormKey is gone from the plugin's listing, and the new one is present.
        var listing = await _client.GetFromJsonAsync<JsonElement>($"/records?plugin={Plugin}&type=npc_");
        var formKeys = listing.GetProperty("items").EnumerateArray()
            .Select(i => i.GetProperty("formKey").GetString()).ToList();
        Assert.DoesNotContain(oldFormKey, formKeys);
        Assert.Contains(newFormKey, formKeys);
    }
}
