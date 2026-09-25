using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Api;

/// <summary>edit-record's Refusals table: a losing copy is read-only (ADR-0012 invariant 5),
/// refused through the real host before any source write. The same write against the winning
/// copy of the same name lands.</summary>
[Collection(WebHostCollection.Name)]
public sealed class LosingCopyRefusalApiTests : HostedTests
{
    private const string PluginName = "Shared.esp";
    private const string WinningOrigin = "WinningMod";
    private const string LosingOrigin = "LosingMod";

    private async Task<ScatteredFixtureData> Loaded()
    {
        var fx = new PluginFixtureBuilder("api-losing-copy")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("WinningNpc"), origin: WinningOrigin)
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("LosingNpc"), origin: LosingOrigin)
            .BuildScattered();

        // BuildScattered gives every explicit copy Winning: true and its own slot; a losing copy of
        // a listed name carries the winning one's own slot instead (PluginMetadata).
        var winningSlot = fx.Plugins.First(p => p.Origin == WinningOrigin).Slot;
        var plugins = fx.Plugins.Select(p => p.Origin == LosingOrigin
            ? p with { Slot = winningSlot, Winning = false }
            : p).ToList();
        (await Client.PutLoadOrder(fx, plugins)).EnsureSuccessStatusCode();
        (await Client.Track([(PluginName, WinningOrigin), (PluginName, LosingOrigin)])).EnsureSuccessStatusCode();
        return fx;
    }

    private static async Task<JsonElement> Body(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    private async Task<string> FormKeyOf(string origin)
    {
        var records = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={PluginName}&origin={origin}&type=npc_");
        return records.GetProperty("items")[0].GetProperty("formKey").GetString()
            ?? throw new InvalidOperationException($"Expected {origin}'s copy to hold an npc_ record.");
    }

    [Fact]
    public async Task EditingTheLosingCopy_IsRefused_NamingThePluginItsOriginAndThatTheGameDoesNotLoadIt()
    {
        using var fx = await Loaded();
        var formKey = await FormKeyOf(LosingOrigin);

        var response = await Client.Edit(formKey, PluginName, LosingOrigin, "HeightMax", 0.75);

        Assert.Equal((HttpStatusCode)422, response.StatusCode);
        var problem = await Body(response);
        Assert.Equal("LosingCopy", problem.GetProperty("refusal").GetString());
        var detail = problem.GetProperty("detail").GetString().Require();
        Assert.Contains(PluginName, detail, StringComparison.Ordinal);
        Assert.Contains(LosingOrigin, detail, StringComparison.Ordinal);
        Assert.Contains("does not load", detail, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task EditingTheLosingCopy_WritesNothing()
    {
        using var fx = await Loaded();
        var formKey = await FormKeyOf(LosingOrigin);
        var before = TreeSnapshot.Of(OtherTool.ModFolderOf(fx, LosingOrigin));

        await Client.Edit(formKey, PluginName, LosingOrigin, "HeightMax", 0.75);

        Assert.Equal(before, TreeSnapshot.Of(OtherTool.ModFolderOf(fx, LosingOrigin)));
    }

    [Fact]
    public async Task EditingTheWinningCopy_OfTheSameName_Lands()
    {
        using var fx = await Loaded();
        var formKey = await FormKeyOf(WinningOrigin);

        var response = await Client.Edit(formKey, PluginName, WinningOrigin, "HeightMax", 0.75);

        response.EnsureSuccessStatusCode();
        Assert.True((await Body(response)).GetProperty("applied").GetBoolean());
    }
}
