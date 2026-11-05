using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Api;

public sealed class PluginNameReferencesApiTests : HostedTests
{
    [Fact]
    public async Task GetPluginNameReferences_AfterALoad_AnswersEachCopyThatNamesTheFileName()
    {
        var fx = Owned(new PluginFixtureBuilder("api-plugin-name-references")
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("Base"), origin: "BaseMod")
            .WithPlugin("Child.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                mod.Npcs.GetOrAddAsOverride(built.Single(m => m.ModKey.FileName == "Base.esm").Npcs.First());
            }, origin: "ChildMod")
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var answer = await Client.GetFromJsonAsync<JsonElement[]>("/plugin-names/Base.esm/references");

        Assert.NotNull(answer);
        Assert.Contains(answer, copy => copy.GetProperty("formKey").GetString() == "000000:Child.esp"
            && copy.GetProperty("plugin").GetProperty("origin").GetString() == "ChildMod");
    }
}
