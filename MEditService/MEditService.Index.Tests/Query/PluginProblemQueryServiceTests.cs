using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Query;

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
        IReadOnlyList<SourceFileFailure> failures, params LoadOrderEntry[] plugins) =>
        Ask(state, tracked.ToDictionary(plugin => plugin.Key, _ => DerivedFrom.SourceTree, PluginAddress.Comparer), missing, failures, plugins);

    private static IReadOnlyList<PluginProblems>? Ask(
        LoadOrderState state, IReadOnlyDictionary<PluginAddress, DerivedFrom> derivations,
        IReadOnlyList<MissingReferenceOnFile> missing, IReadOnlyList<SourceFileFailure> failures, LoadOrderEntry[] plugins)
    {
        var reads = new FakeReads(new Dictionary<PluginAddress, PluginContent>(), [])
        {
            Derivations = derivations,
            MissingReferences = missing,
        };
        var status = new LoadOrderStatus(state, plugins.Length, plugins.Length, [], ConflictsComputed: false, []);
        var index = new FakeIndex(reads, status) { SourceFileFailures = failures };
        return new PluginProblemQueryService(index, FakeLoadOrder.Of(GameRelease.Fallout4, plugins)).GetProblems();
    }

    private static IReadOnlyList<PluginProblems> Ready(
        IReadOnlyList<LoadOrderEntry> tracked, IReadOnlyList<MissingReferenceOnFile> missing, params LoadOrderEntry[] plugins) =>
        Failing(tracked, missing, [], plugins);

    private static IReadOnlyList<PluginProblems> Failing(
        IReadOnlyList<LoadOrderEntry> tracked, IReadOnlyList<MissingReferenceOnFile> missing,
        IReadOnlyList<SourceFileFailure> failures, params LoadOrderEntry[] plugins) =>
        Ask(LoadOrderState.Ready, tracked, missing, failures, plugins) ?? throw new InvalidOperationException("The index was ready.");

    [Fact]
    public void GetProblems_AFileThePluginsReadStoppedAt_IsAProblemOnThatFile_SayingWhy()
    {
        var plugin = Plugin("Broken.esp");
        var stray = new SourceFileFailure(plugin.Key, "Npcs/Stray.json", null, "'Npcs/Stray.json' declares no FormKey.");

        var answer = Assert.Single(Failing([plugin], [], [stray], plugin));

        var problem = Assert.Single(answer.Problems);
        Assert.Equal(
            ((string?)null, (string?)null, "Npcs/Stray.json", "'Npcs/Stray.json' declares no FormKey."),
            (problem.FormKey, problem.TargetFormKey, problem.SourceRelativePath, problem.Message));
        Assert.Null(answer.Failure);
    }

    [Fact]
    public void GetProblems_FilesThatClaimOneFormKey_AreAProblemOnEach_NamingIt()
    {
        var plugin = Plugin("Twice.esp");
        SourceFileFailure Claiming(string file) => new(plugin.Key, file, "000800:Twice.esp", "Both hold 000800:Twice.esp.");

        var answer = Assert.Single(Failing([plugin], [], [Claiming("Npcs/A.json"), Claiming("Npcs/Backup/A.json")], plugin));

        Assert.Equal(
            [("000800:Twice.esp", "Npcs/A.json"), ("000800:Twice.esp", "Npcs/Backup/A.json")],
            answer.Problems.Select(p => (p.FormKey, p.SourceRelativePath)));
    }

    [Fact]
    public void GetProblems_APluginWhoseReadStopsAtAFile_IsAnsweredWithThatFile_AndTheLinksItsLastGoodReadLeft()
    {
        var plugin = Plugin("Broken.esp");

        var answer = Assert.Single(Failing(
            [plugin], [OnFile(plugin)], [new(plugin.Key, "Npcs/Stray.json", null, "Unreadable.")], plugin));

        Assert.Equal(["Npcs/Stray.json", "Npcs/Referrer.json"], answer.Problems.Select(p => p.SourceRelativePath));
        Assert.Null(answer.Failure);
    }

    [Fact]
    public void GetProblems_APluginWhoseReadStopsAtAFile_AndWhoseLinksTheTreeCannotPlace_IsAnsweredWithThatFile_AndTheFailure()
    {
        var plugin = Plugin("Broken.esp");

        var answer = Assert.Single(Failing(
            [plugin], [OnFile(plugin), Unplaced(plugin)], [new(plugin.Key, "Npcs/Stray.json", null, "Unreadable.")], plugin));

        Assert.Equal("Npcs/Stray.json", Assert.Single(answer.Problems).SourceRelativePath);
        Assert.Contains("Broken.esp", answer.Failure, StringComparison.Ordinal);
    }

    [Fact]
    public void GetProblems_APluginItsBinaryStandsInFor_IsAnsweredWithTheFilesItsTreeStopsAt()
    {
        var plugin = Plugin("FellBack.esp");

        var answer = Assert.Single(Failing([], [], [new(plugin.Key, "Npcs/Stray.json", null, "'Npcs/Stray.json' declares no FormKey.")], plugin));

        Assert.Equal(plugin.Key, answer.Plugin);
        var problem = Assert.Single(answer.Problems);
        Assert.Equal(("Npcs/Stray.json", "'Npcs/Stray.json' declares no FormKey."), (problem.SourceRelativePath, problem.Message));
    }

    private static IReadOnlyList<PluginProblems> SourceUnreadable(
        LoadOrderEntry plugin, IReadOnlyList<MissingReferenceOnFile> missing, IReadOnlyList<SourceFileFailure> failures) =>
        Ask(LoadOrderState.Ready,
            new Dictionary<PluginAddress, DerivedFrom>(PluginAddress.Comparer) { [plugin.Key] = DerivedFrom.BinaryForUnreadableSource },
            missing, failures, [plugin])
        ?? throw new InvalidOperationException("The index was ready.");

    [Fact]
    public void GetProblems_APluginWhosePluginSourceIsUnreadable_IsAnsweredWithTheFilesItsReadStoppedAt_AndNoLinkOfItsPluginFile()
    {
        var plugin = Plugin("FellBack.esp");

        var answer = Assert.Single(SourceUnreadable(plugin, [OnFile(plugin)], [new(plugin.Key, "Npcs/Stray.json", null, "Unreadable.")]));

        Assert.Equal(["Npcs/Stray.json"], answer.Problems.Select(p => p.SourceRelativePath));
        Assert.Null(answer.Failure);
    }

    [Fact]
    public void GetProblems_APluginWhosePluginSourceIsMissing_IsAnsweredWithNoProblems()
    {
        var plugin = Plugin("NoSource.esp");

        var answer = Assert.Single(SourceUnreadable(plugin, [Unplaced(plugin)], []));

        Assert.Empty(answer.Problems);
        Assert.Null(answer.Failure);
    }

    [Fact]
    public void GetProblems_AMissingReferenceOfATrackedPlugin_IsAProblemOnTheReferrersFile_NamingItsTarget_WordedAsTheGridWordsIt()
    {
        var plugin = Plugin("Refers.esp");

        var answer = Assert.Single(Ready([plugin], [OnFile(plugin, "Items[10].Item", "000ABC:Absent.esp")], plugin));

        var problem = Assert.Single(answer.Problems);
        Assert.Equal(
            ("000800:Refers.esp", "000ABC:Absent.esp", "Items[10].Item", "Npcs/Referrer.json", "Items[10].Item: [000ABC:Absent.esp] <Error: Could not be resolved>"),
            (problem.FormKey, problem.TargetFormKey, problem.FieldPath, problem.SourceRelativePath, problem.Message));
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

        Assert.Null(Ask(state, [plugin], [], [], plugin));
    }
}
