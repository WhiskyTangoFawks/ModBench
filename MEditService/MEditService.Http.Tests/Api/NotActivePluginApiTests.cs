using System.Text.Json.Nodes;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Http.Tests.Api;

public sealed class NotActivePluginApiTests : HostedTests
{
    private const string DisabledPlugin = "Disabled.esp";
    private const string DisabledOrigin = "DisabledMod";
    private const string OriginPlugin = "Origin.esp";
    private const string OriginOrigin = "OriginMod";

    [Fact]
    public async Task CopyingAsOverride_IntoADisabledPluginWhoseLineIsBeforeTheOrigin_IsRefusedAsAnUnderride()
    {
        using var fx = new PluginFixtureBuilder("api-not-active-copy")
            .WithPlugin(DisabledPlugin, origin: DisabledOrigin, enabled: false)
            .WithPlugin(OriginPlugin, mod => mod.Npcs.AddNew("OriginNpc"), origin: OriginOrigin)
            .BuildScattered();
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(DisabledOrigin)).EnsureSuccessStatusCode();
        var formKey = await Client.FirstFormKey(OriginPlugin, OriginOrigin);

        var response = await Client.Copy(formKey, (OriginPlugin, OriginOrigin), "Override", (DisabledPlugin, DisabledOrigin));

        response.EnsureSuccessStatusCode();
        var refused = Assert.Single((await response.Body()).GetProperty("refused").EnumerateArray());
        Assert.Equal("UnderrideDestination", refused.GetProperty("refusal").GetString());
    }

    [Fact]
    public async Task ClearingDeleted_TakesTheCopyOfADisabledMasterThatItsLineNames()
    {
        var npc = new FormKey(ModKey.FromFileName("Base.esm"), 0x800);
        Action<Fallout4Mod> HeightOf(float height) => mod => mod.Npcs.Add(new Npc(npc, Fallout4Release.Fallout4) { EditorID = "Guy", HeightMax = height });
        using var fx = new PluginFixtureBuilder("api-not-active-walk")
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("Guy").HeightMax = 0.7f)
            .WithPlugin("Middle.esp", HeightOf(0.8f), origin: "FirstMod")
            .WithPlugin("Middle.esp", HeightOf(0.9f), origin: "SecondMod")
            .WithPlugin("Override.esp", mod =>
            {
                mod.Npcs.Add(new Npc(npc, Fallout4Release.Fallout4) { EditorID = "Guy", MajorRecordFlagsRaw = 0x20 });
                mod.Npcs.Add(new Npc(new FormKey(ModKey.FromFileName("Middle.esp"), 0x950), Fallout4Release.Fallout4) { EditorID = "Link" });
            }, origin: "OverrideMod")
            .BuildScattered();
        (await Client.PutLoadOrder(fx, fx.Plugins.Select(p => p.Origin == "SecondMod" ? p with { Enabled = false } : p))).EnsureSuccessStatusCode();
        (await Client.Track("OverrideMod")).EnsureSuccessStatusCode();

        (await Client.Edit(npc.ToString(), "Override.esp", "OverrideMod", "MajorRecordFlagsRaw", 0)).EnsureSuccessStatusCode();

        var undeleted = JsonNode.Parse(await Client.CopyDocumentText(npc.ToString(), "Override.esp", "OverrideMod")).Require();
        Assert.Equal(0.9f, undeleted["HeightMax"].Require().GetValue<float>());
    }
}
