using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Api;

/// <summary>edit-record's Refusals table: a plugin with no plugins.txt line is read-only (ADR-0012
/// invariant 5), refused before any source write. A disabled line is still a line, so its plugin
/// stays writable.</summary>
[Collection(WebHostCollection.Name)]
public sealed class UnlistedPluginRefusalApiTests : HostedTests
{
    private const string UnlistedPlugin = "Unlisted.esp";
    private const string UnlistedOrigin = "UnlistedMod";
    private const string DisabledPlugin = "Disabled.esp";
    private const string DisabledOrigin = "DisabledMod";

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
        Assert.Empty((await Body(track)).GetProperty("refused").EnumerateArray());
        return fx;
    }

    private static async Task<JsonElement> Body(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    private async Task<string> FormKeyOf(string plugin, string origin)
    {
        var records = await Client.GetFromJsonAsync<JsonElement>($"/records?plugin={plugin}&origin={origin}&type=npc_");
        return records.GetProperty("items")[0].GetProperty("formKey").GetString()
            ?? throw new InvalidOperationException($"Expected {plugin} ({origin}) to hold an npc_ record.");
    }

    [Fact]
    public async Task EditingAPluginWithNoLine_IsAConflict_NamingThePluginItsOriginAndPluginSync()
    {
        using var fx = await Loaded();
        var formKey = await FormKeyOf(UnlistedPlugin, UnlistedOrigin);

        var response = await Client.Edit(formKey, UnlistedPlugin, UnlistedOrigin, "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await Body(response);
        Assert.Equal("UnlistedPlugin", problem.GetProperty("refusal").GetString());
        var detail = problem.GetProperty("detail").GetString().Require();
        Assert.Contains(UnlistedPlugin, detail, StringComparison.Ordinal);
        Assert.Contains(UnlistedOrigin, detail, StringComparison.Ordinal);
        Assert.Contains("plugin sync", detail, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task EditingAPluginWithNoLine_WritesNothing()
    {
        using var fx = await Loaded();
        var formKey = await FormKeyOf(UnlistedPlugin, UnlistedOrigin);
        var before = TreeSnapshot.Of(OtherTool.ModFolderOf(fx, UnlistedOrigin));

        await Client.Edit(formKey, UnlistedPlugin, UnlistedOrigin, "HeightMax", 0.75);

        Assert.Equal(before, TreeSnapshot.Of(OtherTool.ModFolderOf(fx, UnlistedOrigin)));
    }

    [Fact]
    public async Task EditingAPluginOnADisabledLine_Lands()
    {
        using var fx = await Loaded();
        var formKey = await FormKeyOf(DisabledPlugin, DisabledOrigin);

        var response = await Client.Edit(formKey, DisabledPlugin, DisabledOrigin, "HeightMax", 0.75);

        response.EnsureSuccessStatusCode();
        Assert.True((await Body(response)).GetProperty("applied").GetBoolean());
    }
}
