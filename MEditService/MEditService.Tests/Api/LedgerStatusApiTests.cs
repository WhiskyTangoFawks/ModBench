using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using MEditService.Core.Ledger;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Api;

/// <summary>
/// #368 Slice 1: <c>GET /ledger/status</c>, observed through the real git CLI (never mocked) —
/// same fixture/host shape as <see cref="VendorOnFirstTouchApiTests"/> (scattered, per-origin-folder
/// fixture; the real <c>PATCH /records/{formKey}</c> stage endpoint produces the working-tree dirt
/// this reads back, rather than fabricating git state directly).
/// </summary>
public class LedgerStatusApiTests
{
    private static async Task LoadAsync(HttpClient client, ScatteredFixtureData fx)
    {
        var load = await client.PostAsJsonAsync("/session/load-explicit", new
        {
            gameDirectory = fx.GameDirectory,
            plugins = fx.Plugins.Select(p => new { name = p.Name, path = p.Path, origin = p.Origin, participates = true }),
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();
    }

    private static async Task PatchAsync(HttpClient client, string formKey, string plugin, string field, object value)
    {
        var resp = await client.PatchAsJsonAsync($"/records/{Uri.EscapeDataString(formKey)}", new
        {
            plugin,
            fields = new Dictionary<string, object?> { [field] = value },
            source = "user",
        });
        resp.EnsureSuccessStatusCode();
    }

    // The server's own JSON options (Program.cs) add JsonStringEnumConverter so LedgerChangeKind
    // travels as "Modified" rather than a raw int; System.Net.Http.Json's client-side default
    // options don't share that config, so ChangeKind needs the same converter here to round-trip.
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    private static async Task<List<LedgerStatusEntry>> GetStatusAsync(HttpClient client)
    {
        var entries = await client.GetFromJsonAsync<List<LedgerStatusEntry>>("/ledger/status", JsonOptions);
        return entries ?? [];
    }

    [Fact]
    public async Task NoSessionLoaded_Returns200WithEmptyList()
    {
        using var host = VendoringTestHost.Create();

        // #368 decision: a read-only status projection answers "no tracked changes" for "no
        // session", the same true-and-complete-answer shape /session/status already uses for "no
        // load in progress" — never the 400 the write endpoints use for "cannot mutate without one".
        var resp = await host.Client.GetAsync("/ledger/status");
        resp.EnsureSuccessStatusCode();
        var entries = await resp.Content.ReadFromJsonAsync<List<LedgerStatusEntry>>();
        Assert.Empty(entries ?? []);
    }

    [Fact]
    public async Task DirtiedRecord_AppearsWithCommittedAndDirtyTextDistinct()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;

        Mutagen.Bethesda.Plugins.FormKey npcFk = default;
        using var fx = new PluginFixtureBuilder("ledger-status-single")
            .WithPlugin("Vendor.esp", mod => npcFk = mod.Npcs.AddNew("VendorNpc").FormKey, origin: "VendorMod")
            .BuildScattered();
        var npcFormKey = npcFk.ToString();
        await LoadAsync(client, fx);

        await PatchAsync(client, npcFormKey, "Vendor.esp", "aggression", "Frenzied");

        var entries = await GetStatusAsync(client);
        var entry = Assert.Single(entries);

        Assert.Equal("Vendor.esp", entry.Plugin);
        Assert.Equal("VendorMod", entry.Origin);
        Assert.Equal("npc_", entry.RecordType);
        Assert.Equal(npcFormKey, entry.FormKey);
        Assert.Equal(LedgerChangeKind.Modified, entry.ChangeKind);

        // Committed side never contains the staged edit — it's the pristine baseline.
        Assert.DoesNotContain("Frenzied", entry.CommittedText, StringComparison.Ordinal);

        // The dirty side is a real file on disk, not backend-supplied text — this is what the
        // frontend opens directly as the diff's "dirty" side with no further round trip.
        Assert.True(File.Exists(entry.RecordPath));
        var dirty = await File.ReadAllTextAsync(entry.RecordPath);
        Assert.Contains("Frenzied", dirty, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ChangesSpanningTwoOrigins_BothAppear()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;

        Mutagen.Bethesda.Plugins.FormKey npc1 = default, npc2 = default;
        using var fx = new PluginFixtureBuilder("ledger-status-cross-origin")
            .WithPlugin("First.esp", mod => npc1 = mod.Npcs.AddNew("FirstNpc").FormKey, origin: "FirstMod")
            .WithPlugin("Second.esp", mod => npc2 = mod.Npcs.AddNew("SecondNpc").FormKey, origin: "SecondMod")
            .BuildScattered();
        await LoadAsync(client, fx);

        await PatchAsync(client, npc1.ToString(), "First.esp", "aggression", "Frenzied");
        await PatchAsync(client, npc2.ToString(), "Second.esp", "aggression", "VeryAggressive");

        var entries = await GetStatusAsync(client);
        Assert.Equal(2, entries.Count);
        Assert.Contains(entries, e => e.Plugin == "First.esp" && e.Origin == "FirstMod" && e.FormKey == npc1.ToString());
        Assert.Contains(entries, e => e.Plugin == "Second.esp" && e.Origin == "SecondMod" && e.FormKey == npc2.ToString());
    }

    [Fact]
    public async Task UntouchedRecord_DoesNotAppear()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;

        Mutagen.Bethesda.Plugins.FormKey npc1 = default, npc2 = default;
        using var fx = new PluginFixtureBuilder("ledger-status-untouched")
            .WithPlugin("Vendor.esp", mod =>
            {
                npc1 = mod.Npcs.AddNew("VendorNpc1").FormKey;
                npc2 = mod.Npcs.AddNew("VendorNpc2").FormKey;
            }, origin: "VendorMod")
            .BuildScattered();
        await LoadAsync(client, fx);

        await PatchAsync(client, npc1.ToString(), "Vendor.esp", "aggression", "Frenzied");

        var entries = await GetStatusAsync(client);
        var entry = Assert.Single(entries);
        Assert.Equal(npc1.ToString(), entry.FormKey);
    }

    // The regression this guards: an unscoped `git status --porcelain` over the origin folder (the
    // ledger's own working tree) reports the plugin binary, its own `.bak` backup and any other
    // loose file in that folder as untracked "changes" too, since EnsureRepo never writes a
    // .gitignore. Confirmed empirically before landing the pathspec scoping this proves stays in
    // place — this is the one test protecting that finding.
    [Fact]
    public async Task OrdinaryFilesInTheOriginFolder_NeverAppearAsChanges()
    {
        using var host = VendoringTestHost.Create();
        var client = host.Client;

        Mutagen.Bethesda.Plugins.FormKey npcFk = default;
        using var fx = new PluginFixtureBuilder("ledger-status-noise")
            .WithPlugin("Vendor.esp", mod => npcFk = mod.Npcs.AddNew("VendorNpc").FormKey, origin: "VendorMod")
            .BuildScattered();
        await LoadAsync(client, fx);

        await PatchAsync(client, npcFk.ToString(), "Vendor.esp", "aggression", "Frenzied");

        var originFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Origin == "VendorMod").Path)!;
        await File.WriteAllTextAsync(Path.Combine(originFolder, "meta.ini"), "installed=true");
        await File.WriteAllTextAsync(Path.Combine(originFolder, "Vendor.esp.bak"), "not a real backup, just noise");

        var entries = await GetStatusAsync(client);
        var entry = Assert.Single(entries);
        Assert.Equal(npcFk.ToString(), entry.FormKey);
    }
}
