using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Query;

public sealed class PluginProblemQueryServiceTests : IDisposable
{
    private const string Absent = "000ABC:Absent.esp";

    private sealed record Plugin(string Name, string? RefersTo = Absent, bool Enabled = true, bool Tracked = true)
    {
        public string Referrer => $"000800:{Name}";
    }

    private static readonly Plugin Broken = new("Broken.esp");

    private ScatteredFixtureData? _fixture;
    private readonly GatedPluginAdapter _brokensBinaryUnreadable = new(poisonPlugin: Broken.Name);

    public void Dispose()
    {
        _brokensBinaryUnreadable.Dispose();
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
            }, enabled: plugin.Enabled, origin: $"{Path.GetFileNameWithoutExtension(plugin.Name)}Mod");
        }
        _fixture = builder.BuildScattered();
        foreach (var plugin in plugins.Where(p => p.Tracked))
            TrackedMods.Track(Entry(plugin), _fixture.GameDirectory);
        return _fixture.Plugins;
    }

    private ScatteredFixtureData Fixture => _fixture ?? throw new InvalidOperationException("Build the fixture first.");

    private LoadOrderEntry Entry(Plugin plugin) => Fixture.Plugins.Single(entry => entry.Name == plugin.Name);

    private OpenedIndex Reconciled(params Plugin[] plugins)
    {
        Build(plugins);
        return Indexes.Reconciled(Fixture);
    }

    private static IReadOnlyList<PluginProblems> Ready(OpenedIndex index) =>
        index.Problems.GetProblems();

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
        index.NextSnapshotUntil(() => index.Status.Failures.Count > 0, "the re-read's failure");
        return (index, document, backup);
    }

    [Fact]
    public void GetProblems_AFileThePluginsReadStoppedAt_IsAProblemOnThatFile_SayingWhy()
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
        Assert.Null(answer.Failure);
    }

    [Fact]
    public void GetProblems_FilesThatClaimOneFormKey_AreAProblemOnEach_NamingIt()
    {
        var plugin = new Plugin("Twice.esp", RefersTo: null);
        Build(plugin);
        var (document, backup) = BackupClaimingTheFormKeyOf(plugin, "Referrer");
        using var index = Indexes.Reconciled(Fixture);

        var answer = Assert.Single(Ready(index));

        Assert.Equivalent(
            new[] { (plugin.Referrer, document), (plugin.Referrer, backup) },
            answer.Problems.Select(p => (p.FormKey, p.SourceRelativePath)), strict: true);
    }

    [Fact]
    public void GetProblems_APluginWhoseReadStopsAtAFile_IsAnsweredWithThatFile_AndTheLinksItsLastGoodReadLeft()
    {
        var (index, document, backup) = BrokenReadFromItsTree_ThenStoppedByAClaimedFormKey();
        using var _ = index;
        Assert.Null(index.PluginRowOf(Entry(Broken).KeyOf())?.PluginSourceUnreadableReason);

        var answer = Assert.Single(Ready(index));

        Assert.Equivalent(new[] { document, backup }, answer.Problems.SkipLast(1).Select(p => p.SourceRelativePath), strict: true);
        Assert.Equal(
            (Absent, Relative(Broken, SourceFileHolding(Broken, "Referrer"))),
            (answer.Problems[^1].TargetFormKey, answer.Problems[^1].SourceRelativePath));
        Assert.Null(answer.Failure);
    }

    [Fact]
    public void GetProblems_APluginWhoseReadStopsAtAFile_AndWhoseLinksTheTreeCannotPlace_IsAnsweredWithThatFile_AndTheFailure()
    {
        var (index, document, backup) = BrokenReadFromItsTree_ThenStoppedByAClaimedFormKey();
        using var _ = index;

        File.Delete(SourceFileHolding(Broken, "Referrer"));

        var answer = Assert.Single(Ready(index));
        Assert.Equivalent(new[] { document, backup }, answer.Problems.Select(p => p.SourceRelativePath), strict: true);
        Assert.Contains(Broken.Referrer, answer.Failure, StringComparison.Ordinal);
    }

    [Fact]
    public void GetProblems_APluginWhosePluginSourceIsUnreadable_IsAnsweredWithTheFilesItsReadStoppedAt_AndNoLinkOfItsPluginFile()
    {
        var plugin = new Plugin("FellBack.esp");
        Build(plugin);
        var (document, backup) = BackupClaimingTheFormKeyOf(plugin, "Referrer");
        using var index = Indexes.Reconciled(Fixture);
        Assert.NotNull(index.PluginRowOf(Entry(plugin).KeyOf())?.PluginSourceUnreadableReason);

        var answer = Assert.Single(Ready(index));

        Assert.Equal(Entry(plugin).KeyOf(), answer.Plugin);
        Assert.Equivalent(new[] { document, backup }, answer.Problems.Select(p => p.SourceRelativePath), strict: true);
        Assert.All(answer.Problems, p => Assert.Null(p.TargetFormKey));
        Assert.Null(answer.Failure);
    }

    [Fact]
    public void GetProblems_APluginWhosePluginSourceIsMissing_IsAnsweredWithNoProblems()
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
    public void GetProblems_AMissingReferenceOfATrackedPlugin_IsAProblemOnTheReferrersFile_NamingItsTarget_WordedAsTheGridWordsIt()
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

    [Fact]
    public void GetProblems_APluginWhoseReferrerTheTreeCannotPlace_IsAFailureOfThatPluginAlone_NotOfTheAnswer()
    {
        var gone = new Plugin("Gone.esp");
        var intact = new Plugin("Intact.esp");
        using var index = Reconciled(gone, intact);

        File.Delete(SourceFileHolding(gone, "Referrer"));

        var answer = Ready(index);
        var failed = Assert.Single(answer, p => p.Plugin == Entry(gone).KeyOf());
        Assert.Empty(failed.Problems);
        Assert.Contains(gone.Referrer, failed.Failure, StringComparison.Ordinal);
        Assert.Single(Assert.Single(answer, p => p.Plugin == Entry(intact).KeyOf()).Problems);
    }

    [Fact]
    public void GetProblems_AskedBeforeASnapshotNoModProvidesATrackedPluginIn_IsReconciled_AnswersThatPluginWithAFailure()
    {
        var plugin = new Plugin("Unprovided.esp");
        Build(plugin);
        var holder = new LoadOrderHolder();
        OpenedIndex? reconciled = null;
        IReadOnlyList<PluginProblems>? answered = null;
        using var loggers = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider([], entry =>
        {
            if (reconciled is { } ready && entry.Message.StartsWith("Reconciling load order", StringComparison.Ordinal))
                answered ??= ready.Problems.GetProblems();
        })));
        using var index = Indexes.Open(holder, loggerFactory: loggers);
        index.Reconcile(holder, Fixture.GameDirectory, Fixture.Plugins, GameRelease.Fallout4);
        reconciled = index;

        index.Reconcile(
            holder, Fixture.GameDirectory, [Entry(plugin) with { NamedProvider = PluginProvider.NoMod }], GameRelease.Fallout4);

        Assert.NotNull(answered);
        var unprovided = Assert.Single(answered);
        Assert.Empty(unprovided.Problems);
        Assert.Contains("no mod folder provides it", unprovided.Failure, StringComparison.Ordinal);
    }

    [Fact]
    public void GetProblems_AnActiveTrackedPluginWithNoMissingReference_IsAnsweredWithNoProblems()
    {
        var plugin = new Plugin("Clean.esp", RefersTo: null);
        using var index = Reconciled(plugin);

        var answer = Assert.Single(Ready(index));

        Assert.Equal(Entry(plugin).KeyOf(), answer.Plugin);
        Assert.Empty(answer.Problems);
        Assert.Null(answer.Failure);
    }

    [Fact]
    public void GetProblems_AnActivePluginNoTreeBacks_IsNotAnswered_ForItHasNoSourceFile()
    {
        using var index = Reconciled(new Plugin("Binary.esp", Tracked: false));

        Assert.Empty(Ready(index));
    }

    [Fact]
    public void GetProblems_AMissingReferenceOfATrackedPluginThatIsNotActive_IsAProblemOnItsFile()
    {
        var dormant = new Plugin("Dormant.esp", Enabled: false);
        using var index = Reconciled(dormant);

        var answer = Assert.Single(Ready(index));

        Assert.Equal(Entry(dormant).KeyOf(), answer.Plugin);
        var problem = Assert.Single(answer.Problems);
        Assert.Equal(
            (Absent, Path.Combine(PluginSourceRoot.For(dormant.Name), "Npcs", "Referrer - 000800_Dormant.esp.json")),
            (problem.TargetFormKey, problem.SourceRelativePath));
    }

    [Fact]
    public void GetProblems_AReferenceOfAPluginThatIsNotActive_ToARecordItsOwnHolds_OrAnActivePluginHolds_IsNoProblem()
    {
        var active = new Plugin("Active.esp", RefersTo: null);
        var ownRecord = new Plugin("OwnRecord.esp", Enabled: false, RefersTo: "000801:OwnRecord.esp");
        var activeRecord = new Plugin("ActiveRecord.esp", Enabled: false, RefersTo: "000801:Active.esp");
        using var index = Reconciled(active, ownRecord, activeRecord);

        var answers = Ready(index);
        foreach (var plugin in new[] { active, ownRecord, activeRecord })
            Assert.Empty(Assert.Single(answers, answer => answer.Plugin == Entry(plugin).KeyOf()).Problems);
    }

    [Fact]
    public void GetProblems_AFileThePluginsReadStoppedAt_OfAPluginThatIsNotActive_IsAProblemOnThatFile()
    {
        var dormant = new Plugin("DormantTwice.esp", RefersTo: null, Enabled: false);
        Build(dormant);
        var (document, backup) = BackupClaimingTheFormKeyOf(dormant, "Referrer");
        using var index = Indexes.Reconciled(Fixture);

        var answer = Assert.Single(Ready(index));

        Assert.Equivalent(new[] { document, backup }, answer.Problems.Select(p => p.SourceRelativePath), strict: true);
    }

    [Fact]
    public void GetProblems_AReferenceOfAPluginThatIsNotActive_ToARecordOnlyAnotherInactivePluginHolds_IsAProblem()
    {
        var holder = new Plugin("Holder.esp", RefersTo: null, Enabled: false);
        var referrer = new Plugin("Referrer.esp", Enabled: false, RefersTo: "000801:Holder.esp");
        using var index = Reconciled(holder, referrer);

        var answer = Assert.Single(Ready(index), p => p.Plugin == Entry(referrer).KeyOf());

        Assert.Equal("000801:Holder.esp", Assert.Single(answer.Problems).TargetFormKey);
    }

    [Fact]
    public async Task GetProblems_WhileTheIndexIsReconciling_AnswersNothing_ForAPartialSetReadsAsNoProblem()
    {
        var plugins = Build(new Plugin("Clean.esp", RefersTo: null), new Plugin("Later.esp", Tracked: false));
        var holder = new LoadOrderHolder();
        using var gate = new GatedPluginAdapter(gateBefore: "Later.esp");
        using var index = Indexes.Open(holder, gate);
        var load = Task.Run(() => index.Reconcile(holder, Fixture.GameDirectory, plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        Assert.Throws<IndexNotReadyException>(index.Problems.GetProblems);

        gate.Release();
        await load;
    }
}
