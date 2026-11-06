using System.Net;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Api;

public sealed class FormKeyChangeApiTests : HostedTests
{
    private const string Base = "Base.esm";
    private const string BaseOrigin = "BaseMod";

    private async Task<(string Race, string Linking)> Loaded()
    {
        var (race, linking) = ("", "");
        var fx = Owned(new PluginFixtureBuilder("api-form-key-change")
            .WithPlugin(Base, mod => race = mod.Races.AddNew("BaseRace").FormKey.ToString(), origin: BaseOrigin)
            .WithPlugin("Child.esp", mod =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName(Base) });
                var npc = mod.Npcs.AddNew("ChildNpc");
                npc.Race.SetTo(FormKey.Factory(race));
                linking = npc.FormKey.ToString();
            }, origin: "ChildMod")
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.VersionInGit(BaseOrigin)).EnsureSuccessStatusCode();
        await Client.NextCheck(fx);
        await Client.PluginReportsCompiledPlugin(Base);
        return (race, linking);
    }

    private static void NamesTheLinkingCopyLeftBehind(JsonElement answer, string linking) =>
        Assert.Contains(answer.GetProperty("copiesLeftBehind").EnumerateArray(), copy => copy.GetProperty("formKey").GetString() == linking
            && copy.GetProperty("plugin").GetProperty("origin").GetString() == "ChildMod");

    [Fact]
    public async Task AFormKeyChangesChanges_NameEachCopyInAPluginWithNoPluginSourceAsLeftBehind_AndThePluginsTheyChange()
    {
        var (race, linking) = await Loaded();

        var response = await Client.EditChanges(race, Base, BaseOrigin, "FormKey", "000F00:Base.esm");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var answer = await response.Body();
        NamesTheLinkingCopyLeftBehind(answer, linking);
        Assert.Equal([BaseOrigin], answer.GetProperty("plugins").EnumerateArray().Select(plugin => plugin.GetProperty("origin").GetString()));
    }

    [Fact]
    public async Task AScriptsFormKeyChange_Is200_NamingEachCopyInAPluginWithNoPluginSourceAsLeftBehind()
    {
        var (race, linking) = await Loaded();

        var response = await Client.ScriptEdit(race, Base, BaseOrigin, "FormKey", "000F00:Base.esm");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        NamesTheLinkingCopyLeftBehind(await response.Body(), linking);
    }
}
