using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Http.Tests.Api;

public sealed class ScriptReferencesApiTests : HostedTests
{
    [Fact]
    public async Task GetScriptReferences_AfterALoad_AnswersEachCopyThatAttachesTheScript()
    {
        var fx = Owned(new PluginFixtureBuilder("api-script-references")
            .WithPlugin("Holding.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("Holder");
                npc.VirtualMachineAdapter = new VirtualMachineAdapter();
                npc.VirtualMachineAdapter.Scripts.Add(new ScriptEntry { Name = "Attached" });
            }, origin: "HoldingMod")
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();

        var answer = await Client.GetFromJsonAsync<JsonElement[]>("/script-names/Attached/references");

        var copy = Assert.Single(answer ?? []);
        Assert.Equal("HoldingMod", copy.GetProperty("plugin").GetProperty("origin").GetString());
        Assert.Equal(["VirtualMachineAdapter.Scripts[0].Name"], copy.GetProperty("fieldPaths").EnumerateArray().Select(path => path.GetString()));
    }
}
