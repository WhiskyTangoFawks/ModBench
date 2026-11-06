using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Api;

public sealed class FormKeyReferencesApiTests : HostedTests
{
    [Fact]
    public async Task GetFormKeyReferences_AfterALoad_AnswersEachCopyThatLinksTheRecord()
    {
        var race = "";
        var linking = "";
        var fx = Owned(new PluginFixtureBuilder("api-form-key-references")
            .WithPlugin("Base.esm", mod => race = mod.Races.AddNew("BaseRace").FormKey.ToString(), origin: "BaseMod")
            .WithPlugin("Child.esp", mod =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                var npc = mod.Npcs.AddNew("ChildNpc");
                npc.Race.SetTo(FormKey.Factory(race));
                linking = npc.FormKey.ToString();
            }, origin: "ChildMod")
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var answer = await Client.GetFromJsonAsync<JsonElement[]>($"/form-keys/{Uri.EscapeDataString(race)}/references");

        Assert.NotNull(answer);
        Assert.Contains(answer, copy => copy.GetProperty("formKey").GetString() == linking
            && copy.GetProperty("plugin").GetProperty("origin").GetString() == "ChildMod"
            && !copy.GetProperty("inPluginSource").GetBoolean());
    }
}
