using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

/// <summary>A plugin with no plugins.txt line, or on a disabled one, is not active and so read-only
/// (ADR-0012 invariant 5); Overwrite is refused earlier still, for having no mod folder
/// (invariant 2).</summary>
public sealed class UnlistedPluginRefusalApiTests : HostedTests
{
    private const string UnlistedPlugin = "Unlisted.esp";
    private const string UnlistedOrigin = "UnlistedMod";
    private const string DisabledPlugin = "Disabled.esp";
    private const string DisabledOrigin = "DisabledMod";
    private const string StrayPlugin = "Stray.esp";
    private const string StrayOrigin = "StrayMod";
    private const string OverwriteStrayPlugin = "OverwriteStray.esp";

    // No read sees a plugin the game does not load, so each NPC's FormKey is the builder's.
    private readonly Dictionary<string, string> _npcOf = [];

    private Action<Mutagen.Bethesda.Fallout4.Fallout4Mod> Npc(string plugin, string editorId) =>
        mod => _npcOf[plugin] = mod.Npcs.AddNew(editorId).FormKey.ToString();

    private async Task<ScatteredFixtureData> Loaded()
    {
        var fx = new PluginFixtureBuilder("api-unlisted-plugin")
            .WithPlugin(UnlistedPlugin, Npc(UnlistedPlugin, "UnlistedNpc"), origin: UnlistedOrigin)
            .WithPlugin(DisabledPlugin, Npc(DisabledPlugin, "DisabledNpc"), origin: DisabledOrigin)
            .BuildScattered();

        var plugins = fx.Plugins.Select(p => p.Origin switch
        {
            UnlistedOrigin => p with { Slot = null },
            DisabledOrigin => p with { Enabled = false },
            _ => p,
        }).ToList();
        (await Client.PutLoadOrder(fx, plugins)).EnsureSuccessStatusCode();
        var track = await Client.Track([(UnlistedPlugin, UnlistedOrigin), (DisabledPlugin, DisabledOrigin)]);
        track.EnsureSuccessStatusCode();
        Assert.Empty((await track.Body()).GetProperty("refused").EnumerateArray());
        return fx;
    }

    [Fact]
    public async Task EditingAPluginWithNoLine_IsAConflict_NamingThePluginItsOriginAndTheWayOut()
    {
        using var fx = await Loaded();
        var formKey = _npcOf[UnlistedPlugin];

        var response = await Client.Edit(formKey, UnlistedPlugin, UnlistedOrigin, "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Body();
        Assert.Equal("PluginNotActive", problem.GetProperty("refusal").GetString());
        var detail = problem.GetProperty("detail").GetString().Require();
        Assert.Contains(UnlistedPlugin, detail, StringComparison.Ordinal);
        Assert.Contains(UnlistedOrigin, detail, StringComparison.Ordinal);
        Assert.Contains("does not load", detail, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Enabling its line", detail, StringComparison.Ordinal);
    }
}
