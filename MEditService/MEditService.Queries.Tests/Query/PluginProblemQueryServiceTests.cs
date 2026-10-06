using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

public sealed class PluginProblemQueryServiceTests
{
    private static LoadOrderEntry Plugin(string name, bool enabled = true) =>
        new(name, $@"C:\mods\SomeMod\{name}", "SomeMod", enabled ? 0 : null, enabled, Winning: true);

    private static MissingReferenceOnFile OnFile(LoadOrderEntry plugin, string field = "Race", string target = "000ABC:Absent.esp") =>
        new(new MissingReference(plugin.Key, $"000800:{plugin.Name}", "npc_", "Referrer", target, field), "Npcs/Referrer.json", null);

    private static MissingReferenceOnFile Unplaced(LoadOrderEntry plugin) =>
        OnFile(plugin) with { SourceRelativePath = null, Failure = $"{plugin.Name}'s source holds no file for 000800:{plugin.Name}." };

    private static IReadOnlyList<PluginProblems>? Ask(
        LoadOrderState state, IReadOnlyList<LoadOrderEntry> tracked, IReadOnlyList<MissingReferenceOnFile> missing,
        params LoadOrderEntry[] plugins)
    {
        var reads = new FakeReads(new Dictionary<PluginAddress, PluginContent>(), [])
        {
            Tracked = tracked.Select(plugin => plugin.Key).ToHashSet(PluginAddress.Comparer),
            MissingReferences = missing,
        };
        var status = new LoadOrderStatus(state, plugins.Length, plugins.Length, [], ConflictsComputed: false, []);
        return new PluginProblemQueryService(new FakeIndex(reads, status), FakeLoadOrder.Of(GameRelease.Fallout4, plugins))
            .GetProblems();
    }

    private static IReadOnlyList<PluginProblems> Ready(
        IReadOnlyList<LoadOrderEntry> tracked, IReadOnlyList<MissingReferenceOnFile> missing, params LoadOrderEntry[] plugins) =>
        Ask(LoadOrderState.Ready, tracked, missing, plugins) ?? throw new InvalidOperationException("The index was ready.");

    [Fact]
    public void GetProblems_AMissingReferenceOfATrackedPlugin_IsAProblemOnTheReferrersFile_WordedAsTheGridWordsIt()
    {
        var plugin = Plugin("Refers.esp");

        var answer = Assert.Single(Ready([plugin], [OnFile(plugin, "Race", "000ABC:Absent.esp")], plugin));

        var problem = Assert.Single(answer.Problems);
        Assert.Equal(
            ("000800:Refers.esp", "Npcs/Referrer.json", "Race: [000ABC:Absent.esp] <Error: Could not be resolved>"),
            (problem.FormKey, problem.SourceRelativePath, problem.Message));
        Assert.Null(answer.Failure);
    }

    [Fact]
    public void GetProblems_APluginWhoseReferrerTheTreeCannotPlace_IsAFailureOfThatPluginAlone_NotOfTheAnswer()
    {
        var gone = Plugin("Gone.esp");
        var intact = Plugin("Intact.esp");

        var answer = Ready([gone, intact], [OnFile(gone), Unplaced(gone), OnFile(intact)], gone, intact);

        var failed = Assert.Single(answer, p => p.Plugin == gone.Key);
        Assert.Empty(failed.Problems);
        Assert.Contains("Gone.esp", failed.Failure, StringComparison.Ordinal);
        Assert.Single(Assert.Single(answer, p => p.Plugin == intact.Key).Problems);
    }

    [Fact]
    public void GetProblems_AnActiveTrackedPluginWithNoMissingReference_IsAnsweredWithNoProblems()
    {
        var plugin = Plugin("Clean.esp");

        var answer = Assert.Single(Ready([plugin], [], plugin));

        Assert.Equal(plugin.Key, answer.Plugin);
        Assert.Empty(answer.Problems);
        Assert.Null(answer.Failure);
    }

    [Fact]
    public void GetProblems_AnActivePluginNoTreeBacks_IsNotAnswered_ForItHasNoSourceFile()
    {
        Assert.Empty(Ready([], [], Plugin("Binary.esp")));
    }

    [Fact]
    public void GetProblems_ATrackedPluginThatIsNotActive_IsNotAnswered()
    {
        var plugin = Plugin("Dormant.esp", enabled: false);

        Assert.Empty(Ready([plugin], [], plugin));
    }

    [Theory]
    [InlineData(LoadOrderState.Reconciling)]
    [InlineData(LoadOrderState.None)]
    public void GetProblems_BeforeTheIndexIsReady_AnswersNothing_ForAPartialSetReadsAsNoProblem(LoadOrderState state)
    {
        var plugin = Plugin("Clean.esp");

        Assert.Null(Ask(state, [plugin], [], plugin));
    }
}
