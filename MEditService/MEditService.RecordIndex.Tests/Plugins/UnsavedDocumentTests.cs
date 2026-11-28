using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using static MEditService.RecordIndex.Tests.TestSupport.Announcements;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class UnsavedDocumentTests : IDisposable
{
    private const string CompiledPlugin = "CompiledPlugin.esp";
    private const string Absent = "000ABC:Absent.esp";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _compiledPlugin;
    private readonly string _npc;
    private readonly string _race;
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly List<LogEntry> _log = [];
    private readonly ILoggerFactory _loggers;
    private readonly OpenedIndex _index;
    private readonly string _file;

    public UnsavedDocumentTests()
    {
        (FormKey npc, FormKey race) = (default, default);
        _fixture = new PluginFixtureBuilder("unsaved-document")
            .WithPlugin(CompiledPlugin, mod =>
            {
                race = mod.Races.AddNew("PresentRace").FormKey;
                var added = mod.Npcs.AddNew("CompiledPluginNpc");
                added.Race.SetTo(race);
                npc = added.FormKey;
            }, origin: "SourceMod")
            .BuildScattered();
        _compiledPlugin = _fixture.Plugins.Single(p => p.Name == CompiledPlugin);
        (_npc, _race) = (npc.ToString(), race.ToString());
        SourceMods.Init(_compiledPlugin);
        _loggers = LoggerFactory.Create(b => b.AddProvider(new CollectingLoggerProvider(_log)));
        _index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, loggerFactory: _loggers, notifications: _notifications);
        _file = _compiledPlugin.SourceFileOf(_index.DocumentOf(_npc, _compiledPlugin.Key));
    }

    public void Dispose()
    {
        _index.Dispose();
        _loggers.Dispose();
        _fixture.Dispose();
    }

    private string Typed(string from, string to) => File.ReadAllText(_file).Replace(from, to, StringComparison.Ordinal);

    private void Hand(params DocumentChange[] documents) => HandUntil(RowsChanged(_npc), documents);

    private void HandUntil(Predicate<INotification> announced, params DocumentChange[] documents)
    {
        var before = _notifications.Notifications.Count;
        if (documents.Length == 0) _index.CloseUnsaved(_file);
        foreach (var document in documents) _index.TypeUnsaved(document);
        Waits.Reached(() => _notifications.Since(before).Any(n => announced(n)), "the hand-over's announcement");
    }

    private string Relative(string path) => Path.GetRelativePath(_compiledPlugin.ModFolderOf(), path);

    private PluginProblems ProblemsOfCompiledPlugin() => _index.Queries.GetProblems().Value().Single(p => p.Plugin.Name == CompiledPlugin);

    private IReadOnlyList<SourceProblem>? LaterReadFailureOfCompiledPlugin() => LaterReadFailureOf(_index);

    private IReadOnlyList<SourceProblem>? LaterReadFailureOf(OpenedIndex index) =>
        (index.PluginResponseOf(_compiledPlugin.Key) ?? throw new InvalidOperationException($"Expected a row for {CompiledPlugin}.")).LaterReadFailure;

    [Fact]
    public void AHandedDocumentsLinkToAMissingRecord_IsAProblemOnItsFile_AtItsRangeInTheHandedText()
    {
        var handed = "\n\n" + Typed(_race, Absent);

        Hand(new DocumentChange(_file, handed));

        var problem = Assert.Single(ProblemsOfCompiledPlugin().Problems, p => p.TargetFormKey == Absent);
        Assert.Equal(Relative(_file), problem.SourceRelativePath);
        var line = handed.Split('\n').ToList().FindIndex(l => l.Contains(Absent, StringComparison.Ordinal));
        Assert.Equal(line, problem.Range?.Start.Line);
        Assert.NotEqual(0, line);
    }

    [Fact]
    public void AHandedDocumentThatDoesNotParse_IsAnsweredAsItsParseError_OnTheFirstLine_AndNoLink()
    {
        var good = "\n\n" + Typed(_race, Absent);
        Hand(new DocumentChange(_file, good));
        Assert.Contains(ProblemsOfCompiledPlugin().Problems, p => p.TargetFormKey == Absent);

        HandUntil(PluginChanged(_compiledPlugin), new DocumentChange(_file, good + ",,"));

        var problems = ProblemsOfCompiledPlugin();
        var stop = Assert.Single(problems.Problems);
        Assert.Null(stop.TargetFormKey);
        Assert.Equal(Ranges.FirstLine, stop.Range);
        Assert.Equal(ProblemsFailureKind.LaterRead, problems.FailureKind);
    }

    [Fact]
    public void ADroppedDocument_OfAFileSettledLongAgo_IsReadFromItsFileAgain()
    {
        File.SetLastWriteTimeUtc(_file, new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        _index.SignalChange([new PluginChange(_compiledPlugin.Key, [_file])]);
        Hand(new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved\"")));

        Hand();

        Assert.Equal("CompiledPluginNpc", _index.DocumentOf(_npc, _compiledPlugin.Key).EditorId);
    }

    [Fact]
    public void AHandedDocumentThatDoesNotRead_LeavesTheLastGoodRows_AndSaysWhy()
    {
        Hand(new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved\"")));

        HandUntil(PluginChanged(_compiledPlugin), new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved")));

        Assert.Equal("TypedUnsaved", _index.DocumentOf(_npc, _compiledPlugin.Key).EditorId);
        Assert.True(_index.ReadFromItsPluginSource(_compiledPlugin.Key));
        var stop = Assert.Single(LaterReadFailureOfCompiledPlugin() ?? []);
        Assert.Equal(Relative(_file), stop.SourceRelativePath);
        Assert.Contains("is no record document", stop.Message, StringComparison.Ordinal);
        var problems = ProblemsOfCompiledPlugin();
        Assert.Contains(stop.Message, problems.Failure, StringComparison.Ordinal);
        Assert.Equal(ProblemsFailureKind.LaterRead, problems.FailureKind);
        Assert.Contains(problems.Problems, problem => problem.SourceRelativePath == stop.SourceRelativePath && problem.Message == stop.Message);
    }

    [Fact]
    public void AFailedReadWhoseReasonChangesAsITypeOn_IsOneLineInTheLog()
    {
        HandUntil(PluginChanged(_compiledPlugin), new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved")));
        HandUntil(PluginChanged(_compiledPlugin), new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"CompiledPluginNpc\",,")));

        lock (_log) Assert.Single(_log, entry => entry.Level == LogLevel.Warning && entry.Message.Contains(Relative(_file), StringComparison.Ordinal));
    }

    [Fact]
    public void AHandedDocumentThatReadsAgain_ClearsTheFailure_AndRefreshesItsRecord()
    {
        HandUntil(PluginChanged(_compiledPlugin), new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved")));

        Hand(new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedAgain\"")));

        Assert.Equal("TypedAgain", _index.DocumentOf(_npc, _compiledPlugin.Key).EditorId);
        Assert.Null(ProblemsOfCompiledPlugin().Failure);
        Assert.Null(LaterReadFailureOfCompiledPlugin());
    }

    [Fact]
    public void AHandedDocumentThatDoesNotRead_WhenTheIndexOpens_LeavesTheRowsItHeld()
    {
        _index.Dispose();
        var holder = new LoadOrderHolder();
        using var reopened = Indexes.Open(holder);
        reopened.Unsaved.Typed(new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved")));

        reopened.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.True(reopened.ReadFromItsPluginSource(_compiledPlugin.Key));
        Assert.Equal(Relative(_file), Assert.Single(LaterReadFailureOf(reopened) ?? []).SourceRelativePath);
    }

    [Fact]
    public void TheSameTextOnDisk_ReadsItsPluginFile()
    {
        File.WriteAllText(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved"));

        _index.NextCheckUntil(() => _index.ReadFromItsPluginFileForItsUnreadableSource(_compiledPlugin.Key), "the binary read in the tree's place");

        Assert.Null(LaterReadFailureOfCompiledPlugin());
    }

    [Fact]
    public void AHandedDocumentClaimingAnotherRecordsFormKey_LeavesTheLastGoodRows_AndSaysWhy()
    {
        Hand(new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved\"")));

        HandUntil(PluginChanged(_compiledPlugin), new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved\"").Replace(_npc, _race, StringComparison.Ordinal)));

        Assert.Equal("TypedUnsaved", _index.DocumentOf(_npc, _compiledPlugin.Key).EditorId);
        Assert.True(_index.ReadFromItsPluginSource(_compiledPlugin.Key));
        Assert.Contains(LaterReadFailureOfCompiledPlugin() ?? [], stop => stop.SourceRelativePath == Relative(_file) && stop.FormKey == _race);
    }

    [Fact]
    public async Task ADisposalDuringAHandOver_IsNotLoggedAsAFailure()
    {
        var disposed = false;
        _notifications.OnPublish = notification =>
        {
            if (notification is not RowsChangedNotification || disposed) return;
            disposed = true;
            _index.Dispose();
            throw new OperationCanceledException();
        };

        _index.Unsaved.Typed(new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved\"")));
        var holding = _index.Queries.Hold([new HandedPlugin(_compiledPlugin.Key, [_file], [])], CancellationToken.None);
        Waits.Reached(() => disposed, "the disposal");
        await holding.WaitAsync(Waits.Patience);

        lock (_log) Assert.DoesNotContain(_log, entry => entry.Message.Contains("failed unexpectedly", StringComparison.Ordinal));
    }

    [Fact]
    public void AHandOverThatValidatesCleanly_LeavesAFailureTheCheckSet()
    {
        _notifications.FaultsOn = notification => notification is RowsChangedNotification;
        _compiledPlugin.HandEdit(_index.DocumentOf(_npc, _compiledPlugin.Key), "\"CompiledPluginNpc\"", "\"EditedOnDisk\"");
        _index.SignalChange();
        Waits.Reached(() => _index.Status.State == LoadOrderState.Failed, "the check's failed status");

        _notifications.FaultsOn = null;
        Hand(new DocumentChange(_file, Typed("\"EditedOnDisk\"", "\"TypedUnsaved\"")));

        Assert.Equal(LoadOrderState.Failed, _index.Status.State);
    }
}
