using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Http.Tests.Api;

public sealed class PluginDependantsApiTests : HostedTests
{
    [Fact]
    public async Task GetDependants_AfterALoad_NamesThePluginsListingTheFileNameAsAMaster()
    {
        var fx = Owned(new PluginFixtureBuilder("api-dependants")
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("Base"), origin: "BaseMod")
            .WithPlugin("Child.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                mod.Npcs.GetOrAddAsOverride(built.Single(m => m.ModKey.FileName == "Base.esm").Npcs.First());
            }, origin: "ChildMod")
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var answer = await Client.GetFromJsonAsync<JsonElement>("/plugins/Base.esm/dependants?origin=BaseMod");

        var dependant = Assert.Single(answer.GetProperty("dependants").EnumerateArray());
        Assert.Equal(("Child.esp", "ChildMod"), (dependant.GetProperty("name").GetString(), dependant.GetProperty("origin").GetString()));
        Assert.Empty(answer.GetProperty("unreadable").EnumerateArray());
    }
}
