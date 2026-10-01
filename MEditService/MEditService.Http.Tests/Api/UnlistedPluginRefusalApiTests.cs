using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

/// <summary>A plugin with no plugins.txt line, or on a disabled one, is not active and so read-only
/// (ADR-0012 invariant 5); Overwrite is refused earlier still, for having no mod folder
/// (invariant 2).</summary>
[Collection(WebHostCollection.Name)]
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

    // The stray sits in its own mod folder, given no plugins.txt line; tracking is per mod folder,
    // not per line (ADR-0012 invariant 5), so it tracks all the same.
    private async Task<ScatteredFixtureData> LoadedWithAModFolderStray()
    {
        var built = new PluginFixtureBuilder("api-modfolder-stray")
            .WithPlugin(StrayPlugin, Npc(StrayPlugin, "StrayNpc"), origin: StrayOrigin)
            .BuildScattered();
        var fx = built with { Plugins = [.. built.Plugins.Select(p => p with { Slot = null })] };

        (await Client.PutLoadOrder(fx, fx.Plugins)).EnsureSuccessStatusCode();
        var track = await Client.Track(StrayPlugin, StrayOrigin);
        track.EnsureSuccessStatusCode();
        Assert.Empty((await track.Body()).GetProperty("refused").EnumerateArray());
        return fx;
    }

    // The stray sits in the instance's overwrite/ folder, which is never a mod (ADR-0012 invariant 2).
    private async Task<ScatteredFixtureData> LoadedWithAnOverwriteStray()
    {
        var built = new PluginFixtureBuilder("api-overwrite-stray")
            .WithPlugin(OverwriteStrayPlugin, Npc(OverwriteStrayPlugin, "StrayNpc"), origin: PluginOrigin.Overwrite)
            .BuildScattered();
        var overwrite = Path.Combine(built.InstanceRoot, "overwrite");
        Directory.Move(OtherTool.ModFolderOf(built, PluginOrigin.Overwrite), overwrite);
        var fx = built with
        {
            Plugins = [.. built.Plugins.Select(p => p with { Path = Path.Combine(overwrite, OverwriteStrayPlugin), Slot = null })],
        };

        (await Client.PutLoadOrder(fx, fx.Plugins)).EnsureSuccessStatusCode();
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

    [Fact]
    public async Task EditingAPluginWithNoLine_WritesNothing()
    {
        using var fx = await Loaded();
        var formKey = _npcOf[UnlistedPlugin];
        var before = TreeSnapshot.Of(OtherTool.ModFolderOf(fx, UnlistedOrigin));

        await Client.Edit(formKey, UnlistedPlugin, UnlistedOrigin, "HeightMax", 0.75);

        Assert.Equal(before, TreeSnapshot.Of(OtherTool.ModFolderOf(fx, UnlistedOrigin)));
    }

    [Fact]
    public async Task EditingAPluginOnADisabledLine_IsAConflict_WritingNothing()
    {
        using var fx = await Loaded();
        var formKey = _npcOf[DisabledPlugin];
        var before = TreeSnapshot.Of(OtherTool.ModFolderOf(fx, DisabledOrigin));

        var response = await Client.Edit(formKey, DisabledPlugin, DisabledOrigin, "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("PluginNotActive", (await response.Body()).GetProperty("refusal").GetString());
        Assert.Equal(before, TreeSnapshot.Of(OtherTool.ModFolderOf(fx, DisabledOrigin)));
    }

    [Fact]
    public async Task EditingAModFolderStray_IsAConflictAsNotActive_WritingNothing()
    {
        using var fx = await LoadedWithAModFolderStray();
        var formKey = _npcOf[StrayPlugin];
        var before = TreeSnapshot.Of(OtherTool.ModFolderOf(fx, StrayOrigin));

        var response = await Client.Edit(formKey, StrayPlugin, StrayOrigin, "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("PluginNotActive", (await response.Body()).GetProperty("refusal").GetString());
        Assert.Equal(before, TreeSnapshot.Of(OtherTool.ModFolderOf(fx, StrayOrigin)));
    }

    [Fact]
    public async Task EditingAnOverwriteStray_IsAConflict_AsNoModFolder_WritingNothing()
    {
        using var fx = await LoadedWithAnOverwriteStray();
        var formKey = _npcOf[OverwriteStrayPlugin];
        var before = TreeSnapshot.Of(OtherTool.ModFolderOf(fx, PluginOrigin.Overwrite));

        var response = await Client.Edit(formKey, OverwriteStrayPlugin, PluginOrigin.Overwrite, "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Body();
        Assert.Equal("PluginHasNoModFolder", problem.GetProperty("refusal").GetString());
        Assert.Contains("Overwrite", problem.GetProperty("detail").GetString().Require(), StringComparison.Ordinal);
        Assert.Equal(before, TreeSnapshot.Of(OtherTool.ModFolderOf(fx, PluginOrigin.Overwrite)));
    }
}
