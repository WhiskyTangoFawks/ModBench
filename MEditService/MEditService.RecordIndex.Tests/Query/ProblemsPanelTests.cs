using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class ProblemsPanelTests : IDisposable
{
    private const string Absent = "000ABC:Absent.esp";

    private sealed record Plugin(string Name, string? RefersTo = Absent, bool Enabled = true, bool CompiledPlugin = true, bool ResponseWithNoneEmotion = false, int ResponsesWithMissingEmotion = 0, int MissingKeywords = 0)
    {
        public string Referrer => $"000800:{Name}";
    }

    private static readonly Plugin Broken = new("Broken.esp");

    private ScatteredFixtureData? _fixture;
    private readonly GatedPluginAdapter _brokensBinaryUnreadable = new(poisonPlugin: Broken.Name);
    private readonly List<GatedPluginAdapter> _poisoned = [];

    public void Dispose()
    {
        _brokensBinaryUnreadable.Dispose();
        _poisoned.ForEach(adapter => adapter.Dispose());
        _fixture?.Dispose();
    }

    private IReadOnlyList<LoadOrderEntry> Build(params Plugin[] plugins)
    {
        var builder = new PluginFixtureBuilder("plugin-problems");
        foreach (var plugin in plugins)
        {
            builder.WithPlugin(plugin.Name, mod =>
            {
                var referrer = mod.Npcs.AddNew("Referrer");
                if (plugin.RefersTo is { } target) referrer.Race.SetTo(FormKey.Factory(target));
                mod.Npcs.AddNew("Other");
                if (plugin.ResponseWithNoneEmotion) AddResponsesWithEmotion(mod, FormKey.None);
                if (plugin.ResponsesWithMissingEmotion > 0) AddResponsesWithEmotion(mod, [.. Enumerable.Repeat(FormKey.Factory(Absent), plugin.ResponsesWithMissingEmotion)]);
                if (plugin.MissingKeywords > 0)
                {
                    referrer.Keywords = [.. Enumerable.Repeat(new FormLink<IKeywordGetter>(FormKey.Factory(Absent)), plugin.MissingKeywords)];
                }
            }, enabled: plugin.Enabled, origin: $"{Path.GetFileNameWithoutExtension(plugin.Name)}Mod");
        }
        _fixture = builder.BuildScattered();
        foreach (var plugin in plugins.Where(p => p.CompiledPlugin))
            SourceMods.Init(Entry(plugin));
        return _fixture.Plugins;
    }

    private static void AddResponsesWithEmotion(Fallout4Mod mod, params FormKey[] emotions)
    {
        var topic = new DialogTopic(mod.GetNextFormKey(), Fallout4Release.Fallout4);
        foreach (var emotion in emotions)
        {
            var response = new DialogResponse();
            response.Emotion.SetTo(emotion);
            var responses = new DialogResponses(mod.GetNextFormKey(), Fallout4Release.Fallout4);
            responses.Responses.Add(response);
            topic.Responses.Add(responses);
        }
        var quest = new Quest(mod.GetNextFormKey(), Fallout4Release.Fallout4);
        quest.DialogTopics.Add(topic);
        mod.Quests.Add(quest);
    }

    private ScatteredFixtureData Fixture => _fixture ?? throw new InvalidOperationException("Build the fixture first.");

    private LoadOrderEntry Entry(Plugin plugin) => Fixture.Plugins.Single(entry => entry.Name == plugin.Name);

    private OpenedIndex Reconciled(params Plugin[] plugins)
    {
        Build(plugins);
        return Indexes.Reconciled(Fixture);
    }

    private static IReadOnlyList<PluginProblems> Ready(OpenedIndex index) =>
        index.Queries.GetProblems().Value();

    private string SourceFileHolding(Plugin plugin, string editorId) =>
        Directory.EnumerateFiles(PluginSourceRoot.In(Entry(plugin).ModFolderOf(), plugin.Name), "*.json", SearchOption.AllDirectories)
            .Single(file => File.ReadAllText(file).Contains($"\"{editorId}\"", StringComparison.Ordinal));

    private string Relative(Plugin plugin, string path) => Path.GetRelativePath(Entry(plugin).ModFolderOf(), path);

    private (string Document, string Backup) BackupClaimingTheFormKeyOf(Plugin plugin, string editorId)
    {
        var document = SourceFileHolding(plugin, editorId);
        var backup = Path.Combine(
            Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(document) ?? "", "Backup")).FullName, Path.GetFileName(document));
        File.Copy(document, backup);
        return (Relative(plugin, document), Relative(plugin, backup));
    }

    private (OpenedIndex Index, string Document, string Backup) BrokenReadFromItsTree_ThenStoppedByAClaimedFormKey()
    {
        Build(Broken);
        var index = Indexes.Reconciled(Fixture, adapter: _brokensBinaryUnreadable);
        var (document, backup) = BackupClaimingTheFormKeyOf(Broken, "Other");
        index.NextCheckUntil(() => index.Status.Failures.Count > 0, "the re-read's failure");
        return (index, document, backup);
    }

    [Fact]
    public void AFileThePluginsReadStoppedAt_IsAProblemOnThatFile_SayingWhy()
    {
        var plugin = new Plugin("Strayed.esp", RefersTo: null);
        Build(plugin);
        var stray = Path.Combine(Path.GetDirectoryName(SourceFileHolding(plugin, "Other")) ?? "", "Stray.json");
        File.WriteAllText(stray, "{}");
        using var index = Indexes.Reconciled(Fixture);

        var answer = Assert.Single(Ready(index));

        var problem = Assert.Single(answer.Problems);
        Assert.Equal(
            ((string?)null, (string?)null, Relative(plugin, stray)),
            (problem.FormKey, problem.TargetFormKey, problem.SourceRelativePath));
        Assert.Contains("declares no FormKey", problem.Message, StringComparison.Ordinal);
        Assert.Equal(Ranges.FirstLine, problem.Range);
        Assert.Null(answer.Failure);
    }

    [Fact]
    public void GivenAPlugin_OnlyThatPluginIsAnswered()
    {
        var other = new Plugin("Other.esp");
        using var index = Reconciled(Broken, other);

        var answer = Assert.Single(index.Queries.GetProblems(Entry(other).Key).Value());

        Assert.Equal(Entry(other).Key, answer.Plugin);
    }

    [Fact]
    public void GivenAPluginNameWithAnotherOrigin_NothingIsAnswered()
    {
        using var index = Reconciled(Broken);

        Assert.Empty(index.Queries.GetProblems(new PluginAddress(Broken.Name, "AnotherMod")).Value());
    }

    [Fact]
    public void AProblemWhoseFileCannotBeReadToPlaceIt_StaysOnTheFirstLine_AndItsPluginIsAnsweredWithThePlacementFailure()
    {
        var plugin = new Plugin("Strayed.esp", RefersTo: null);
        Build(plugin);
        var stray = Path.Combine(Path.GetDirectoryName(SourceFileHolding(plugin, "Other")) ?? "", "Stray.json");
        File.WriteAllText(stray, "{}");
        using var index = Indexes.Reconciled(Fixture);
        File.Delete(stray);

        var answer = Assert.Single(Ready(index));

        Assert.Equal(Ranges.FirstLine, Assert.Single(answer.Problems).Range);
        Assert.Contains("Stray.json could not be read to place its problems", answer.Failure, StringComparison.Ordinal);
        Assert.Equal(ProblemsFailureKind.Placement, answer.FailureKind);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void FilesThatClaimOneFormKey_AreAProblemOnEach_NamingIt_ActiveOrNot(bool enabled)
    {
        var plugin = new Plugin("Twice.esp", RefersTo: null, Enabled: enabled);
        Build(plugin);
        var (document, backup) = BackupClaimingTheFormKeyOf(plugin, "Referrer");
        using var index = Indexes.Reconciled(Fixture);

        var answer = Assert.Single(Ready(index));

        Assert.Equivalent(
            new[] { (plugin.Referrer, document), (plugin.Referrer, backup) },
            answer.Problems.Select(p => (p.FormKey, p.SourceRelativePath)), strict: true);
    }

    [Fact]
    public void APluginWhoseReadStopsAtAFile_IsAnsweredWithThatFile_AndTheLinksItsLastGoodReadLeft()
    {
        var (index, document, backup) = BrokenReadFromItsTree_ThenStoppedByAClaimedFormKey();
        using var _ = index;
        Assert.Null(index.PluginResponseOf(Entry(Broken).Key)?.PluginSourceUnreadable);

        var answer = Assert.Single(Ready(index));

        Assert.Equivalent(new[] { document, backup }, answer.Problems.SkipLast(1).Select(p => p.SourceRelativePath), strict: true);
        Assert.Equal(
            (Absent, Relative(Broken, SourceFileHolding(Broken, "Referrer"))),
            (answer.Problems[^1].TargetFormKey, answer.Problems[^1].SourceRelativePath));
        Assert.Contains("Could not read this plugin", answer.Failure, StringComparison.Ordinal);
    }

    [Fact]
    public void APluginWhoseReadStopsAtAFile_AndWhoseLinksTheTreeCannotPlace_IsAnsweredWithThatFile_AndTheFailure()
    {
        var (index, document, backup) = BrokenReadFromItsTree_ThenStoppedByAClaimedFormKey();
        using var _ = index;

        File.Delete(SourceFileHolding(Broken, "Referrer"));

        var answer = Assert.Single(Ready(index));
        Assert.Equivalent(new[] { document, backup }, answer.Problems.Select(p => p.SourceRelativePath), strict: true);
        Assert.Contains(Broken.Referrer, answer.Failure, StringComparison.Ordinal);
        Assert.Equal(ProblemsFailureKind.Placement, answer.FailureKind);
    }

    [Fact]
    public void APluginWhosePluginSourceIsUnreadable_IsAnsweredWithTheFilesItsReadStoppedAt_AndNoLinkOfItsPluginFile()
    {
        var plugin = new Plugin("FellBack.esp");
        Build(plugin);
        var (document, backup) = BackupClaimingTheFormKeyOf(plugin, "Referrer");
        using var index = Indexes.Reconciled(Fixture);
        Assert.NotNull(index.PluginResponseOf(Entry(plugin).Key)?.PluginSourceUnreadable);

        var answer = Assert.Single(Ready(index));

        Assert.Equal(Entry(plugin).Key, answer.Plugin);
        Assert.Equivalent(new[] { document, backup }, answer.Problems.Select(p => p.SourceRelativePath), strict: true);
        Assert.All(answer.Problems, p => Assert.Null(p.TargetFormKey));
        Assert.Null(answer.Failure);
    }

    [Fact]
    public void APluginWhosePluginSourceIsMissing_IsAnsweredWithNoProblems()
    {
        var plugin = new Plugin("NoSource.esp");
        Build(plugin);
        Directory.Delete(PluginSourceRoot.In(Entry(plugin).ModFolderOf(), plugin.Name), recursive: true);
        using var index = Indexes.Reconciled(Fixture);

        var answer = Assert.Single(Ready(index));

        Assert.Empty(answer.Problems);
        Assert.Null(answer.Failure);
    }

    [Fact]
    public void ADialogueResponsesNoneEmotion_IsAValueNotAReference_SoItIsNoProblem()
    {
        using var index = Reconciled(new Plugin("Speaks.esp", RefersTo: null, ResponseWithNoneEmotion: true));

        var answer = Assert.Single(Ready(index));

        Assert.Empty(answer.Problems);
        Assert.Null(answer.Failure);
    }

    [Fact]
    public void AMissingReferenceOfACompiledPlugin_IsAProblemOnTheReferrersFile_NamingItsTarget_WordedAsTheGridWordsIt()
    {
        var plugin = new Plugin("Refers.esp");
        using var index = Reconciled(plugin);

        var answer = Assert.Single(Ready(index));

        var problem = Assert.Single(answer.Problems);
        Assert.Equal(
            ("000800:Refers.esp", Absent, "Race",
             Path.Combine(PluginSourceRoot.For(plugin.Name), "Npcs", "Referrer - 000800_Refers.esp.json"),
             "Race: [000ABC:Absent.esp] <Error: Could not be resolved>"),
            (problem.FormKey, problem.TargetFormKey, problem.FieldPath, problem.SourceRelativePath, problem.Message));
        Assert.Null(answer.Failure);
    }

    private static SourceRange RangeOf(string text, string token)
    {
        var start = text.IndexOf(token, StringComparison.Ordinal);
        SourcePosition At(int offset)
        {
            var before = text[..offset];
            var line = before.Count(c => c == '\n');
            return new(line, offset - (before.LastIndexOf('\n') + 1));
        }
        return new(At(start), At(start + token.Length));
    }

    [Fact]
    public void AMissingReferenceOfACompiledPlugin_CarriesTheRangeOfItsTargetInTheReferrersFile()
    {
        var plugin = new Plugin("Refers.esp");
        using var index = Reconciled(plugin);

        var problem = Assert.Single(Assert.Single(Ready(index)).Problems);

        Assert.Equal(RangeOf(File.ReadAllText(SourceFileHolding(plugin, "Referrer")), $"\"{Absent}\""), problem.Range);
    }

    [Fact]
    public void AMissingReferenceInAnEmbeddedChild_CarriesItsRangeInTheOwnersFile()
    {
        var plugin = new Plugin("Speaks.esp", RefersTo: null, ResponsesWithMissingEmotion: 1);
        using var index = Reconciled(plugin);

        var problem = Assert.Single(Assert.Single(Ready(index)).Problems);

        var owner = Path.Combine(Entry(plugin).ModFolderOf(), problem.SourceRelativePath);
        Assert.Equal(RangeOf(File.ReadAllText(owner), $"\"{Absent}\""), problem.Range);
    }

    private string TextOf(Plugin plugin, SourceProblem problem) =>
        File.ReadAllText(Path.Combine(Entry(plugin).ModFolderOf(), problem.SourceRelativePath));

    [Fact]
    public void RecordsOfOneFileCitingTheSameMissingRecord_EachCarryTheRangeOfTheirOwnReference()
    {
        var plugin = new Plugin("Speaks.esp", RefersTo: null, ResponsesWithMissingEmotion: 2);
        using var index = Reconciled(plugin);

        var problems = Assert.Single(Ready(index)).Problems;

        Assert.Equal(2, problems.Count);
        Assert.All(problems, problem =>
        {
            var text = TextOf(plugin, problem);
            var own = RangeOf(text, problem.FormKey ?? "").Start;
            var cited = text.Split('\n').Select((line, number) => (line, number)).Where(l => l.number >= own.Line && l.line.Contains(Absent, StringComparison.Ordinal)).First().number;
            Assert.Equal(cited, problem.Range?.Start.Line);
        });
        Assert.Equal(2, problems.Select(problem => problem.Range?.Start.Line).Distinct().Count());
    }

    [Fact]
    public void LinksAtDifferentElementsOfOneList_EachCarryTheRangeOfTheirOwnElement()
    {
        var plugin = new Plugin("Lists.esp", RefersTo: null, MissingKeywords: 3);
        using var index = Reconciled(plugin);

        var problems = Assert.Single(Ready(index)).Problems.OrderBy(problem => problem.FieldPath, StringComparer.Ordinal).ToList();

        var text = TextOf(plugin, problems[0]);
        var lines = text.Split('\n').Select((line, number) => (line, number)).Where(l => l.line.Contains(Absent, StringComparison.Ordinal)).Select(l => l.number).ToList();
        Assert.Equal(lines, problems.Select(problem => problem.Range?.Start.Line ?? -1).ToList());
        Assert.Equal(3, lines.Count);
    }

    [Fact]
    public void FilesThatClaimOneFormKey_EachCarryTheRangeOfTheFormKeyTheyDeclare()
    {
        var plugin = new Plugin("Twice.esp", RefersTo: null);
        Build(plugin);
        BackupClaimingTheFormKeyOf(plugin, "Referrer");
        using var index = Indexes.Reconciled(Fixture);

        var problems = Assert.Single(Ready(index)).Problems;

        Assert.Equal(2, problems.Count);
        Assert.All(problems, problem => Assert.Equal(RangeOf(TextOf(plugin, problem), $"\"{plugin.Referrer}\""), problem.Range));
    }

    private const string Unreadable = "Unreadable.esp";

    private GatedPluginAdapter Poisoning(string plugin)
    {
        var adapter = new GatedPluginAdapter(poisonPlugin: plugin);
        _poisoned.Add(adapter);
        return adapter;
    }

    private OpenedIndex ReconciledWithPoisoned(string poisoned, params Plugin[] plugins)
    {
        Build(plugins);
        return Indexes.Reconciled(Fixture, adapter: Poisoning(poisoned));
    }

    [Fact]
    public void ALinkIntoAnActivePluginThatCannotBeRead_IsAProblemOnTheReferrersFile_SayingItWasNotChecked_NotThatItIsMissing()
    {
        using var index = ReconciledWithPoisoned(
            Unreadable, new Plugin(Unreadable, CompiledPlugin: false), new Plugin("Refers.esp", RefersTo: $"000800:{Unreadable}"));

        var answer = Assert.Single(Ready(index));

        var link = Assert.Single(answer.Problems, p => p.FieldPath == "Race");
        Assert.StartsWith($"Race: {Unreadable} could not be read, so this link was not checked: ", link.Message, StringComparison.Ordinal);
        Assert.Equal(Unreadable, link.UncheckedBecause);
    }

    [Fact]
    public void AMissingLink_IsNotAskedAboutAnUnreadablePlugin_ItDoesNotName()
    {
        using var index = ReconciledWithPoisoned(Unreadable, new Plugin(Unreadable, CompiledPlugin: false), new Plugin("Refers.esp"));

        var answer = Assert.Single(Ready(index));

        var link = Assert.Single(answer.Problems, p => p.FieldPath == "Race");
        Assert.Contains("Could not be resolved", link.Message, StringComparison.Ordinal);
        Assert.Null(link.UncheckedBecause);
    }

    public sealed record ExpectedProblem(string? FieldPath, string File, string MessageStart);

    private const string HeaderFile = "000000_Refers.esp.json";
    private const string ReferrerFile = "Referrer - 000800_Refers.esp.json";

    public static TheoryData<string?, ExpectedProblem[]> ByWhatTheLinksNamed => new()
    {
        {
            "000800:Unreadable.esp",
            [
                new(null, HeaderFile, "Unreadable.esp is in the load order but could not be read, so no link into it was checked: "),
                new("Race", ReferrerFile, "Race: Unreadable.esp could not be read, so this link was not checked: "),
            ]
        },
        { Absent, [new("Race", ReferrerFile, "Race: [000ABC:Absent.esp] <Error: Could not be resolved>")] },
        { null, [] },
    };

    [Theory]
    [MemberData(nameof(ByWhatTheLinksNamed))]
    public void AnActivePluginThatCannotBeRead_IsAProblemOnTheHeaderFile_OnlyOfACompiledPluginWithALinkIntoIt(
        string? refersTo, ExpectedProblem[] expected)
    {
        var plugin = new Plugin("Refers.esp", RefersTo: refersTo);
        using var index = ReconciledWithPoisoned(Unreadable, new Plugin(Unreadable, CompiledPlugin: false), plugin);

        var answer = Assert.Single(Ready(index));

        Assert.Collection(
            answer.Problems,
            [.. expected.Select(want => (Action<SourceProblem>)(problem =>
            {
                Assert.Equal(want.FieldPath, problem.FieldPath);
                Assert.StartsWith(want.MessageStart, problem.Message, StringComparison.Ordinal);
                Assert.EndsWith(want.File, problem.SourceRelativePath, StringComparison.Ordinal);
            }))]);
    }

    [Fact]
    public void ACompiledPluginNoModProvides_WhoseLinksAreNotChecked_IsAFailureOfThatPlugin_ForItsHeaderHasNoPlace()
    {
        var plugin = new Plugin("Unprovided.esp", RefersTo: $"000801:{Unreadable}");
        Build(new Plugin(Unreadable, CompiledPlugin: false), plugin);
        var holder = new LoadOrderHolder();
        OpenedIndex? reconciled = null;
        IReadOnlyList<PluginProblems>? answered = null;
        using var loggers = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider([], entry =>
        {
            if (reconciled is { } ready && entry.Message.StartsWith("Reconciling load order", StringComparison.Ordinal))
                answered ??= ready.Queries.GetProblems().Value();
        })));
        using var index = Indexes.Open(holder, adapter: Poisoning(Unreadable), loggerFactory: loggers);
        index.Reconcile(holder, Fixture.DataFolder, Fixture.Plugins, GameRelease.Fallout4);
        reconciled = index;

        index.Reconcile(
            holder, Fixture.DataFolder, [.. Fixture.Plugins.Select(entry => entry.Name == plugin.Name ? entry with { NamedProvider = PluginProvider.NoMod } : entry)], GameRelease.Fallout4);

        Assert.NotNull(answered);
        var unprovided = Assert.Single(answered);
        Assert.Empty(unprovided.Problems);
        Assert.Equal(ProblemsFailureKind.Placement, unprovided.FailureKind);
    }

    [Fact]
    public void AnInactivePluginThatCannotBeRead_IsNoProblemOnAnyFile_AndLeavesAMissingLinkMissing()
    {
        using var index = ReconciledWithPoisoned(
            Unreadable, new Plugin(Unreadable, Enabled: false, CompiledPlugin: false), new Plugin("Refers.esp", RefersTo: $"000800:{Unreadable}"));

        var answer = Assert.Single(Ready(index));

        var link = Assert.Single(answer.Problems);
        Assert.Contains("Could not be resolved", link.Message, StringComparison.Ordinal);
        Assert.Null(link.UncheckedBecause);
    }

    [Fact]
    public void TwoCopiesOfAPluginThatCannotBeRead_AreAnsweredByTheActiveOne()
    {
        var builder = new PluginFixtureBuilder("plugin-problems");
        builder.WithPlugin(Unreadable, mod => mod.Npcs.AddNew("Other"), enabled: false, origin: "InactiveCopy");
        builder.WithPlugin(Unreadable, mod => mod.Npcs.AddNew("Other"), enabled: true, origin: "ActiveCopy");
        builder.WithPlugin("Refers.esp", mod => mod.Npcs.AddNew("Referrer").Race.SetTo(FormKey.Factory($"000800:{Unreadable}")), origin: "RefersMod");
        _fixture = builder.BuildScattered();
        SourceMods.Init(Fixture.Plugins.Single(entry => entry.Name == "Refers.esp"));
        using var index = Indexes.Reconciled(Fixture, adapter: Poisoning(Unreadable));

        var answer = Assert.Single(Ready(index));

        var link = Assert.Single(answer.Problems, p => p.FieldPath == "Race");
        Assert.Equal(Unreadable, link.UncheckedBecause);
    }

    [Fact]
    public void APluginWhoseReferrerTheTreeCannotPlace_IsAFailureOfThatPluginAlone_NotOfTheAnswer()
    {
        var gone = new Plugin("Gone.esp");
        var intact = new Plugin("Intact.esp");
        using var index = Reconciled(gone, intact);

        File.Delete(SourceFileHolding(gone, "Referrer"));

        var answer = Ready(index);
        var failed = Assert.Single(answer, p => p.Plugin == Entry(gone).Key);
        Assert.Empty(failed.Problems);
        Assert.Contains(gone.Referrer, failed.Failure, StringComparison.Ordinal);
        Assert.Equal(ProblemsFailureKind.Placement, failed.FailureKind);
        Assert.Single(Assert.Single(answer, p => p.Plugin == Entry(intact).Key).Problems);
    }

    [Fact]
    public void AskedBeforeASnapshotNoModProvidesACompiledPluginIn_IsReconciled_TheProblemsAnswerThatPluginWithAFailure()
    {
        var plugin = new Plugin("Unprovided.esp");
        Build(plugin);
        var holder = new LoadOrderHolder();
        OpenedIndex? reconciled = null;
        IReadOnlyList<PluginProblems>? answered = null;
        using var loggers = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider([], entry =>
        {
            if (reconciled is { } ready && entry.Message.StartsWith("Reconciling load order", StringComparison.Ordinal))
                answered ??= ready.Queries.GetProblems().Value();
        })));
        using var index = Indexes.Open(holder, loggerFactory: loggers);
        index.Reconcile(holder, Fixture.DataFolder, Fixture.Plugins, GameRelease.Fallout4);
        reconciled = index;

        index.Reconcile(
            holder, Fixture.DataFolder, [Entry(plugin) with { NamedProvider = PluginProvider.NoMod }], GameRelease.Fallout4);

        Assert.NotNull(answered);
        var unprovided = Assert.Single(answered);
        Assert.Empty(unprovided.Problems);
        Assert.Contains("no mod folder provides it", unprovided.Failure, StringComparison.Ordinal);
        Assert.Equal(ProblemsFailureKind.Placement, unprovided.FailureKind);
    }

    [Fact]
    public void AnActiveCompiledPluginWithNoMissingReference_IsAnsweredWithNoProblems()
    {
        var plugin = new Plugin("Clean.esp", RefersTo: null);
        using var index = Reconciled(plugin);

        var answer = Assert.Single(Ready(index));

        Assert.Equal(Entry(plugin).Key, answer.Plugin);
        Assert.Empty(answer.Problems);
        Assert.Null(answer.Failure);
    }

    [Fact]
    public void AnActivePluginNoTreeBacks_IsNotAnswered_ForItHasNoSourceFile()
    {
        using var index = Reconciled(new Plugin("Binary.esp", CompiledPlugin: false));

        Assert.Empty(Ready(index));
    }

    [Fact]
    public void AMissingReferenceOfACompiledPluginThatIsNotActive_IsAProblemOnItsFile()
    {
        var dormant = new Plugin("Dormant.esp", Enabled: false);
        using var index = Reconciled(dormant);

        var answer = Assert.Single(Ready(index));

        Assert.Equal(Entry(dormant).Key, answer.Plugin);
        var problem = Assert.Single(answer.Problems);
        Assert.Equal(
            (Absent, Path.Combine(PluginSourceRoot.For(dormant.Name), "Npcs", "Referrer - 000800_Dormant.esp.json")),
            (problem.TargetFormKey, problem.SourceRelativePath));
    }

    [Fact]
    public void AReferenceOfAPluginThatIsNotActive_ToARecordItsOwnHolds_OrAnActivePluginHolds_IsNoProblem()
    {
        var active = new Plugin("Active.esp", RefersTo: null);
        var ownRecord = new Plugin("OwnRecord.esp", Enabled: false, RefersTo: "000801:OwnRecord.esp");
        var activeRecord = new Plugin("ActiveRecord.esp", Enabled: false, RefersTo: "000801:Active.esp");
        using var index = Reconciled(active, ownRecord, activeRecord);

        var answers = Ready(index);

        Assert.Equal(
            [(Entry(active).Key, 0), (Entry(activeRecord).Key, 0), (Entry(ownRecord).Key, 0)],
            answers.Select(answer => (answer.Plugin, answer.Problems.Count)).OrderBy(answer => answer.Plugin.Name, StringComparer.Ordinal));
    }

    [Fact]
    public void AReferenceOfAPluginThatIsNotActive_ToARecordOnlyAnotherInactivePluginHolds_IsAProblem()
    {
        var holder = new Plugin("Holder.esp", RefersTo: null, Enabled: false);
        var referrer = new Plugin("Referrer.esp", Enabled: false, RefersTo: "000801:Holder.esp");
        using var index = Reconciled(holder, referrer);

        var answer = Assert.Single(Ready(index), p => p.Plugin == Entry(referrer).Key);

        Assert.Equal("000801:Holder.esp", Assert.Single(answer.Problems).TargetFormKey);
    }
}
