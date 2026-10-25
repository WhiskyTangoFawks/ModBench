using System.Net;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Http.Tests.Traces;

public sealed class ScriptEditTraceTests : HostedTests
{
    private const string Plugin = "Scripted.esp";
    private const string Origin = "ScriptedMod";
    private const string Npc = "ScriptedNpc";

    private async Task<(string NpcFile, string FormKey)> LoadedAndCompiledPlugin()
    {
        var fx = Owned(new PluginFixtureBuilder("trace-script-edit")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc), origin: Origin)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        return (
            Directory.EnumerateFiles(OtherTool.ModFolderOf(fx, Origin), $"{Npc} - *.json", SearchOption.AllDirectories).Single(),
            await Client.FirstFormKey(Plugin, Origin));
    }

    [Fact]
    public async Task AnEdit_Is204_AndWritesTheRecordsDocument()
    {
        var (npcFile, formKey) = await LoadedAndCompiledPlugin();

        var response = await Client.ScriptEdit(formKey, Plugin, Origin, "HeightMax", 0.75);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Contains("0.75", File.ReadAllText(npcFile), StringComparison.Ordinal);
    }
}
