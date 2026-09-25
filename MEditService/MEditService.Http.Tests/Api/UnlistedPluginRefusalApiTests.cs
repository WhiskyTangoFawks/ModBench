using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

/// <summary>edit-record's Refusals table: a plugin with no plugins.txt line, a mod's or an Overwrite
/// stray, is read-only (ADR-0012 invariant 5). A disabled line is still a line, so its plugin stays
/// writable.</summary>
[Collection(WebHostCollection.Name)]
public sealed class UnlistedPluginRefusalApiTests : HostedTests
{
    private const string UnlistedPlugin = "Unlisted.esp";
    private const string UnlistedOrigin = "UnlistedMod";
    private const string DisabledPlugin = "Disabled.esp";
    private const string DisabledOrigin = "DisabledMod";
    private const string StrayPlugin = "Stray.esp";
    private const string OverwriteOrigin = "overwrite";

    private async Task<ScatteredFixtureData> Loaded()
    {
        var fx = new PluginFixtureBuilder("api-unlisted-plugin")
            .WithPlugin(UnlistedPlugin, mod => mod.Npcs.AddNew("UnlistedNpc"), origin: UnlistedOrigin)
            .WithPlugin(DisabledPlugin, mod => mod.Npcs.AddNew("DisabledNpc"), origin: DisabledOrigin)
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

    // The stray sits in the instance's overwrite/ folder, where no mod manager adds a line for it.
    private async Task<ScatteredFixtureData> LoadedWithAnOverwriteStray()
    {
        var built = new PluginFixtureBuilder("api-overwrite-stray")
            .WithPlugin(StrayPlugin, mod => mod.Npcs.AddNew("StrayNpc"), origin: OverwriteOrigin)
            .BuildScattered();
        var overwrite = Path.Combine(built.InstanceRoot, OverwriteOrigin);
        Directory.Move(OtherTool.ModFolderOf(built, OverwriteOrigin), overwrite);
        var fx = built with
        {
            Plugins = [.. built.Plugins.Select(p => p with { Path = Path.Combine(overwrite, StrayPlugin), Slot = null })],
        };

        (await Client.PutLoadOrder(fx, fx.Plugins)).EnsureSuccessStatusCode();
        var track = await Client.Track(StrayPlugin, OverwriteOrigin);
        track.EnsureSuccessStatusCode();
        Assert.Empty((await track.Body()).GetProperty("refused").EnumerateArray());
        return fx;
    }

    [Fact]
    public async Task EditingAPluginWithNoLine_IsAConflict_NamingThePluginItsOriginAndPluginSync()
    {
        using var fx = await Loaded();
        var formKey = await Client.FirstFormKeyIn(UnlistedPlugin, UnlistedOrigin);

        var response = await Client.Edit(formKey, UnlistedPlugin, UnlistedOrigin, "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Body();
        Assert.Equal("UnlistedPlugin", problem.GetProperty("refusal").GetString());
        var detail = problem.GetProperty("detail").GetString().Require();
        Assert.Contains(UnlistedPlugin, detail, StringComparison.Ordinal);
        Assert.Contains(UnlistedOrigin, detail, StringComparison.Ordinal);
        Assert.Contains("does not load", detail, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("plugin sync", detail, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task EditingAPluginWithNoLine_WritesNothing()
    {
        using var fx = await Loaded();
        var formKey = await Client.FirstFormKeyIn(UnlistedPlugin, UnlistedOrigin);
        var before = TreeSnapshot.Of(OtherTool.ModFolderOf(fx, UnlistedOrigin));

        await Client.Edit(formKey, UnlistedPlugin, UnlistedOrigin, "HeightMax", 0.75);

        Assert.Equal(before, TreeSnapshot.Of(OtherTool.ModFolderOf(fx, UnlistedOrigin)));
    }

    [Fact]
    public async Task EditingAPluginOnADisabledLine_Lands()
    {
        using var fx = await Loaded();
        var formKey = await Client.FirstFormKeyIn(DisabledPlugin, DisabledOrigin);

        var response = await Client.Edit(formKey, DisabledPlugin, DisabledOrigin, "HeightMax", 0.75);

        response.EnsureSuccessStatusCode();
        Assert.True((await response.Body()).GetProperty("applied").GetBoolean());
    }

    [Fact]
    public async Task EditingAnOverwriteStray_IsAConflictAsUnlisted_WritingNothing()
    {
        using var fx = await LoadedWithAnOverwriteStray();
        var formKey = await Client.FirstFormKeyIn(StrayPlugin, OverwriteOrigin);
        var before = TreeSnapshot.Of(OtherTool.ModFolderOf(fx, OverwriteOrigin));

        var response = await Client.Edit(formKey, StrayPlugin, OverwriteOrigin, "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("UnlistedPlugin", (await response.Body()).GetProperty("refusal").GetString());
        Assert.Equal(before, TreeSnapshot.Of(OtherTool.ModFolderOf(fx, OverwriteOrigin)));
    }
}
