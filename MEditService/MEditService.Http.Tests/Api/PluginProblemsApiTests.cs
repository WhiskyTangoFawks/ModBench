using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Http.Tests.Api;

public sealed class PluginProblemsApiTests : HostedTests
{
    private const string Plugin = "Refers.esp";
    private const string Origin = "ReferringMod";
    private const string Npc = "ReferringNpc";

    private static readonly FormKey AbsentRecord = FormKey.Factory("000ABC:Absent.esp");

    private async Task<ScatteredFixtureData> TrackedLoad()
    {
        var fx = Owned(new PluginFixtureBuilder("api-plugin-problems")
            .WithPlugin(Plugin, mod => mod.Npcs.AddNew(Npc).Race.SetTo(AbsentRecord), origin: Origin)
            .WithPlugin("Plain.esp", mod => mod.Npcs.AddNew("PlainNpc"), origin: "PlainMod")
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsTracked(Plugin);
        return fx;
    }

    [Fact]
    public async Task GetProblems_ATrackedPluginReferringToAMissingRecord_NamesTheReferrersFileInTheModFolder()
    {
        var fx = await TrackedLoad();
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Name == Plugin).Path).Require();

        var answer = await Client.GetFromJsonAsync<JsonElement>("/plugins/problems");

        var plugin = Assert.Single(answer.EnumerateArray());
        Assert.Equal((Plugin, Origin), (plugin.GetProperty("plugin").GetProperty("name").GetString(), plugin.GetProperty("plugin").GetProperty("origin").GetString()));
        var problem = Assert.Single(plugin.GetProperty("problems").EnumerateArray());
        Assert.Equal(await Client.FirstFormKey(Plugin, Origin), problem.GetProperty("formKey").GetString());
        Assert.Contains(AbsentRecord.ToString(), problem.GetProperty("message").GetString().Require(), StringComparison.Ordinal);
        Assert.Contains(Npc, File.ReadAllText(Path.Combine(modFolder, problem.GetProperty("sourceRelativePath").GetString().Require())), StringComparison.Ordinal);
    }

    [Fact]
    public async Task GetProblems_WithNoLoadOrder_Is503()
    {
        var response = await Client.GetAsync(new Uri("/plugins/problems", UriKind.Relative));

        await response.AssertIsProblem(HttpStatusCode.ServiceUnavailable);
    }
}
