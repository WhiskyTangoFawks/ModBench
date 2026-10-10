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
    public async Task GetProblems_ATrackedPluginReferringToAMissingRecord_NamesTheReferrersFileInTheModFolder_WhichSpellsTheTargetAsAnswered()
    {
        var fx = await TrackedLoad();
        var modFolder = Path.GetDirectoryName(fx.Plugins.Single(p => p.Name == Plugin).Path).Require();

        var answer = await Client.GetFromJsonAsync<JsonElement>("/plugins/problems");

        var plugin = Assert.Single(answer.EnumerateArray());
        Assert.Equal((Plugin, Origin), (plugin.GetProperty("plugin").GetProperty("name").GetString(), plugin.GetProperty("plugin").GetProperty("origin").GetString()));
        var problem = Assert.Single(plugin.GetProperty("problems").EnumerateArray());
        Assert.Equal(await Client.FirstFormKey(Plugin, Origin), problem.GetProperty("formKey").GetString());
        Assert.Equal(AbsentRecord.ToString(), problem.GetProperty("targetFormKey").GetString());
        Assert.Contains(AbsentRecord.ToString(), problem.GetProperty("message").GetString().Require(), StringComparison.Ordinal);
        var file = File.ReadAllText(Path.Combine(modFolder, problem.GetProperty("sourceRelativePath").GetString().Require()));
        Assert.Contains(Npc, file, StringComparison.Ordinal);
        Assert.Contains(JsonSerializer.Serialize(AbsentRecord.ToString()), file, StringComparison.Ordinal);
    }

    private async Task<JsonElement[]> ProblemsOnceTheyAre(Func<JsonElement[], bool> answered, string what)
    {
        var problems = Array.Empty<JsonElement>();
        await Wire.Eventually(async () =>
        {
            var response = await Client.GetAsync(new Uri("/plugins/problems", UriKind.Relative));
            if (response.StatusCode != HttpStatusCode.OK) return false;
            var plugin = (await response.Content.ReadFromJsonAsync<JsonElement>()).EnumerateArray()
                .Single(p => p.GetProperty("plugin").GetProperty("name").GetString() == Plugin);
            problems = [.. plugin.GetProperty("problems").EnumerateArray()];
            return answered(problems);
        }, what);
        return problems;
    }

    private static string PathOf(JsonElement problem) => problem.GetProperty("sourceRelativePath").GetString().Require();

    [Fact]
    public async Task GetProblems_AFileSavedThatCompileCannotRead_IsTheProblemOnItsPluginsSource_UntilItIsMended()
    {
        var fx = await TrackedLoad();
        var modFolder = OtherTool.ModFolderOf(fx, Origin);
        var stray = OtherTool.Beside(OtherTool.SourceDocumentCarrying(modFolder, Plugin, Npc), "Stray.json");

        OtherTool.WritesTheFile(stray, "{");
        await Client.NextSnapshot(fx);

        var problems = await ProblemsOnceTheyAre(
            problems => problems.Length == 1 && PathOf(problems[0]) == Path.GetRelativePath(modFolder, stray),
            "the unreadable file alone");
        var problem = Assert.Single(problems);
        Assert.Equal(JsonValueKind.Null, problem.GetProperty("formKey").ValueKind);
        Assert.Equal(JsonValueKind.Null, problem.GetProperty("targetFormKey").ValueKind);

        OtherTool.DeletesTheFile(stray);
        await Client.NextSnapshot(fx);

        await ProblemsOnceTheyAre(
            problems => problems.Select(p => p.GetProperty("targetFormKey").GetString()).SequenceEqual([AbsentRecord.ToString()]),
            "the missing record's link alone");
    }

    [Fact]
    public async Task GetProblems_WithNoLoadOrder_Is503()
    {
        var response = await Client.GetAsync(new Uri("/plugins/problems", UriKind.Relative));

        await response.AssertIsProblem(HttpStatusCode.ServiceUnavailable);
    }
}
