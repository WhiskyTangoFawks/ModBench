using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Http.Tests.Api;

public sealed class ScriptRenameSourceChangesApiTests : HostedTests
{
    private const string Plugin = "Holding.esp";
    private const string Origin = "HoldingMod";

    private Task<HttpResponseMessage> Renaming(object request) => Client.PostAsJsonAsync("/script-names/rename-source-changes", request);

    [Fact]
    public async Task RenamingAScript_AnswersEachPluginSourceDocumentThatNamesIt_WithTheNewName()
    {
        var fx = Owned(new PluginFixtureBuilder("api-script-rename")
            .WithPlugin(Plugin, mod =>
            {
                var npc = mod.Npcs.AddNew("Holder");
                npc.VirtualMachineAdapter = new VirtualMachineAdapter();
                npc.VirtualMachineAdapter.Scripts.Add(new ScriptEntry { Name = "Attached" });
            }, origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.VersionInGit(Origin)).EnsureSuccessStatusCode();
        await Client.NextCheck(fx);
        await Client.PluginReportsCompiledPlugin(Plugin);

        var response = await Renaming(new { name = "Attached", newName = "Renamed" });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var changes = await response.Content.ReadFromJsonAsync<JsonElement>();
        var document = Assert.Single(changes.GetProperty("documents").EnumerateArray());
        Assert.Equal(
            (true, false, Origin),
            (document.GetProperty("text").GetString()?.Contains("\"Renamed\"", StringComparison.Ordinal), document.GetProperty("text").GetString()?.Contains("Attached", StringComparison.Ordinal),
                changes.GetProperty("plugins")[0].GetProperty("origin").GetString()));
    }

    [Fact]
    public async Task ARenameWithNoNewName_Is400()
    {
        await (await Renaming(new { name = "Attached", newName = "" })).AssertIsProblem(HttpStatusCode.BadRequest);
    }
}
