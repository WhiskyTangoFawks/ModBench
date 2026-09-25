using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Api;

/// <summary>edit-record's Refusals table: an overridden plugin is read-only (ADR-0012 invariant 5),
/// refused through the real host before any source write. The same write against the winning
/// plugin of the same name lands.</summary>
[Collection(WebHostCollection.Name)]
public sealed class OverriddenPluginRefusalApiTests : HostedTests
{
    private const string PluginName = "Shared.esp";
    private const string WinningOrigin = "WinningMod";
    private const string OverriddenOrigin = "OverriddenMod";

    private async Task<ScatteredFixtureData> Loaded()
    {
        var fx = new PluginFixtureBuilder("api-overridden-plugin")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("WinningNpc"), origin: WinningOrigin)
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("OverriddenNpc"), origin: OverriddenOrigin)
            .BuildScattered();

        // BuildScattered gives every explicit plugin Winning: true and its own slot; an overridden
        // plugin of a listed name carries the winning one's own slot instead (PluginMetadata).
        var winningSlot = fx.Plugins.First(p => p.Origin == WinningOrigin).Slot;
        var plugins = fx.Plugins.Select(p => p.Origin == OverriddenOrigin
            ? p with { Slot = winningSlot, Winning = false }
            : p).ToList();
        (await Client.PutLoadOrder(fx, plugins)).EnsureSuccessStatusCode();
        (await Client.Track([(PluginName, WinningOrigin), (PluginName, OverriddenOrigin)])).EnsureSuccessStatusCode();
        return fx;
    }

    [Fact]
    public async Task EditingTheOverriddenPlugin_IsRefused_NamingThePluginItsOriginAndThatTheGameDoesNotLoadIt()
    {
        using var fx = await Loaded();
        var formKey = await Client.FirstFormKeyIn(PluginName, OverriddenOrigin);

        var response = await Client.Edit(formKey, PluginName, OverriddenOrigin, "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await response.Body();
        Assert.Equal("OverriddenPlugin", problem.GetProperty("refusal").GetString());
        var detail = problem.GetProperty("detail").GetString().Require();
        Assert.Contains(PluginName, detail, StringComparison.Ordinal);
        Assert.Contains(OverriddenOrigin, detail, StringComparison.Ordinal);
        Assert.Contains("does not load", detail, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task EditingTheOverriddenPlugin_WritesNothing()
    {
        using var fx = await Loaded();
        var formKey = await Client.FirstFormKeyIn(PluginName, OverriddenOrigin);
        var before = TreeSnapshot.Of(OtherTool.ModFolderOf(fx, OverriddenOrigin));

        await Client.Edit(formKey, PluginName, OverriddenOrigin, "HeightMax", 0.75);

        Assert.Equal(before, TreeSnapshot.Of(OtherTool.ModFolderOf(fx, OverriddenOrigin)));
    }

    [Fact]
    public async Task EditingTheWinningPlugin_OfTheSameName_Lands()
    {
        using var fx = await Loaded();
        var formKey = await Client.FirstFormKeyIn(PluginName, WinningOrigin);

        var response = await Client.Edit(formKey, PluginName, WinningOrigin, "HeightMax", 0.75);

        response.EnsureSuccessStatusCode();
        Assert.True((await response.Body()).GetProperty("applied").GetBoolean());
    }
}
