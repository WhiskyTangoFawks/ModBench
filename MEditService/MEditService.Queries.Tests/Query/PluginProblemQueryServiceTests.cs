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

    private static IReadOnlyList<PluginProblems>? Ask(
        LoadOrderState state, IReadOnlyList<LoadOrderEntry> tracked, params LoadOrderEntry[] plugins)
    {
        var reads = new FakeReads(new Dictionary<PluginAddress, PluginContent>(), [])
        {
            Tracked = tracked.Select(plugin => plugin.Key).ToHashSet(PluginAddress.Comparer),
        };
        var status = new LoadOrderStatus(state, plugins.Length, plugins.Length, [], ConflictsComputed: false, []);
        return new PluginProblemQueryService(new FakeIndex(reads, status), FakeLoadOrder.Of(GameRelease.Fallout4, plugins))
            .GetProblems();
    }

    [Fact]
    public void GetProblems_AnActiveTrackedPluginWithNoMissingReference_IsAnsweredWithNoProblems()
    {
        var plugin = Plugin("Clean.esp");

        var answer = Assert.Single(Ask(LoadOrderState.Ready, [plugin], plugin) ?? throw new InvalidOperationException("The index was ready."));

        Assert.Equal(plugin.Key, answer.Plugin);
        Assert.Empty(answer.Problems);
    }

    [Fact]
    public void GetProblems_AnActivePluginNoTreeBacks_IsNotAnswered_ForItHasNoSourceFile()
    {
        var plugin = Plugin("Binary.esp");

        Assert.Empty(Ask(LoadOrderState.Ready, [], plugin) ?? throw new InvalidOperationException("The index was ready."));
    }

    [Fact]
    public void GetProblems_ATrackedPluginThatIsNotActive_IsNotAnswered()
    {
        var plugin = Plugin("Dormant.esp", enabled: false);

        Assert.Empty(Ask(LoadOrderState.Ready, [plugin], plugin) ?? throw new InvalidOperationException("The index was ready."));
    }

    [Theory]
    [InlineData(LoadOrderState.Reconciling)]
    [InlineData(LoadOrderState.None)]
    public void GetProblems_BeforeTheIndexIsReady_AnswersNothing_ForAPartialSetReadsAsNoProblem(LoadOrderState state)
    {
        var plugin = Plugin("Clean.esp");

        Assert.Null(Ask(state, [plugin], plugin));
    }
}
