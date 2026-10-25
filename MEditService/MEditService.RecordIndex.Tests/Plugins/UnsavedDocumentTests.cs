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
        _index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, notifications: _notifications);
        _file = _compiledPlugin.SourceFileOf(_index.DocumentOf(_npc, _compiledPlugin.Key));
    }

    private string InstanceRootNamed(string name) =>
        Directory.CreateDirectory(Path.Combine(_fixture.InstanceRoot, name)).FullName;

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private string Typed(string from, string to) => File.ReadAllText(_file).Replace(from, to, StringComparison.Ordinal);

    private void Hand(params DocumentChange[] documents) => HandUntil(RowsChanged(_npc), documents);

    private void HandUntil(Predicate<INotification> announced, params DocumentChange[] documents)
    {
        var before = _notifications.Notifications.Count;
        _index.Unsaved.Apply(documents);
        Waits.Reached(() => _notifications.Since(before).Any(n => announced(n)), "the hand-over's announcement");
    }

    private string Relative(string path) => Path.GetRelativePath(_compiledPlugin.ModFolderOf(), path);

    private PluginProblems ProblemsOfCompiledPlugin() => _index.Queries.GetProblems().Value().Single(p => p.Plugin.Name == CompiledPlugin);

    private IReadOnlyList<SourceProblem>? LaterReadFailureOfCompiledPlugin() => LaterReadFailureOf(_index);

    private IReadOnlyList<SourceProblem>? LaterReadFailureOf(OpenedIndex index) =>
        (index.PluginResponseOf(_compiledPlugin.Key) ?? throw new InvalidOperationException($"Expected a row for {CompiledPlugin}.")).LaterReadFailure;

    [Fact]
    public void AHandedDocument_IsReadInPlaceOfItsFile()
    {
        Hand(new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved\"")));

        Assert.Equal("TypedUnsaved", _index.DocumentOf(_npc, _compiledPlugin.Key).EditorId);
    }

    [Fact]
    public void ADroppedDocument_IsReadFromItsFileAgain()
    {
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
        var log = new List<LogEntry>();
        using var loggers = LoggerFactory.Create(b => b.AddProvider(new CollectingLoggerProvider(log)));
        var notifications = new InMemoryNotificationPublisher();
        using var logged = Indexes.Reconciled(_fixture, InstanceRootNamed("logged"), loggerFactory: loggers, notifications: notifications);

        foreach (var typed in new[] { Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved"), Typed("\"CompiledPluginNpc\"", "\"CompiledPluginNpc\",,") })
        {
            var before = notifications.Notifications.Count;
            logged.Unsaved.Apply([new DocumentChange(_file, typed)]);
            Waits.Reached(() => notifications.Since(before).Any(n => PluginChanged(_compiledPlugin)(n)), "the failed read announced");
        }

        lock (log) Assert.Single(log, entry => entry.Level == LogLevel.Warning && entry.Message.Contains(Relative(_file), StringComparison.Ordinal));
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
        reopened.Unsaved.Apply([new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved"))]);

        reopened.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.True(reopened.ReadFromItsPluginSource(_compiledPlugin.Key));
        Assert.Equal(Relative(_file), Assert.Single(LaterReadFailureOf(reopened) ?? []).SourceRelativePath);
    }

    [Fact]
    public void TheSameTextOnDisk_ReadsItsPluginFile()
    {
        File.WriteAllText(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved"));

        _index.NextSnapshotUntil(() => _index.ReadFromItsPluginFileForItsUnreadableSource(_compiledPlugin.Key), "the binary read in the tree's place");

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
    public void TheSameClaimOnDisk_ReadsItsPluginFile()
    {
        File.WriteAllText(_file, Typed(_npc, _race));

        _index.NextSnapshotUntil(() => _index.ReadFromItsPluginFileForItsUnreadableSource(_compiledPlugin.Key), "the binary read in the tree's place");

        Assert.Null(LaterReadFailureOfCompiledPlugin());
    }

    [Theory]
    [InlineData(typeof(InvalidOperationException))]
    [InlineData(typeof(OutOfMemoryException))]
    [InlineData(typeof(OperationCanceledException))]
    public void AHandOverWhoseValidationFaultsOutright_FailsTheStatus(Type thrownType)
    {
        var thrown = Faults.Of(thrownType);
        using var faulting = Indexes.Reconciled(
            _fixture, InstanceRootNamed("faulting"), notifications: new InMemoryNotificationPublisher { OnPublish = Faults.On(IsRowsChanged, thrown) });

        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved\""))]);

        Waits.Reached(() => faulting.Status.State == LoadOrderState.Failed, "the failed status");
        Assert.Contains(thrown.Message, faulting.Status.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AHandOverWhoseStatusCannotBePublished_PublishesTheFailedStatusOnceItCan()
    {
        var statusFault = Faults.InTurn(typeof(NotSupportedException));
        var notifications = new InMemoryNotificationPublisher();
        using var faulting = Indexes.Reconciled(_fixture, InstanceRootNamed("faulting"), notifications: notifications);
        notifications.OnPublish = Faults.On(IsRowsChanged, Faults.Of(typeof(InvalidOperationException)))
            + (notification => { if (notification is LoadOrderStatusNotification) statusFault(); });

        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved\""))]);

        Waits.Reached(
            () => notifications.Notifications.OfType<LoadOrderStatusNotification>().Any(n => n.Status.State == LoadOrderState.Failed),
            "the failed status published");
    }

    [Fact]
    public async Task AHandOverArrivingWhileAStatusPublishes_IsAcceptedAtOnce_AndValidatedThoughThatPublishIsCancelledOutsideDisposal()
    {
        using var failedPublishing = new ManualResetEventSlim();
        using var secondHandedOver = new ManualResetEventSlim();
        var statusCancelled = Faults.InTurn(() =>
        {
            failedPublishing.Set();
            secondHandedOver.Wait(TimeSpan.FromMinutes(1));
            throw new OperationCanceledException();
        });
        var notifications = new InMemoryNotificationPublisher();
        using var faulting = Indexes.Reconciled(_fixture, InstanceRootNamed("faulting"), notifications: notifications);
        notifications.OnPublish = Faults.On(IsRowsChanged, Faults.Of(typeof(InvalidOperationException)))
            + (notification => { if (notification is LoadOrderStatusNotification { Status.State: LoadOrderState.Failed }) statusCancelled(); });
        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved\""))]);
        Assert.True(failedPublishing.Wait(Waits.Patience), "the failed status being published");

        notifications.OnPublish = null;
        var secondHandOver = Task.Run(() => faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedAgain\""))]));
        var acceptedWhilePublishing = await Waits.CompletesWithin(secondHandOver, TimeSpan.FromSeconds(5));
        secondHandedOver.Set();

        Assert.True(acceptedWhilePublishing, "the next hand-over accepted while the status was publishing");
        Waits.Reached(() => faulting.Status.State == LoadOrderState.Ready, "the ready status");
    }

    [Fact]
    public async Task ADisposalDuringAHandOver_IsNotLoggedAsAFailure()
    {
        var log = new List<LogEntry>();
        using var loggers = LoggerFactory.Create(b => b.AddProvider(new CollectingLoggerProvider(log)));
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Reconciled(_fixture, InstanceRootNamed("disposed"), loggerFactory: loggers, notifications: notifications);
        var disposed = false;
        notifications.OnPublish = notification =>
        {
            if (!IsRowsChanged(notification) || disposed) return;
            disposed = true;
            index.Dispose();
            throw new OperationCanceledException();
        };

        index.Unsaved.Apply([new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved\""))]);
        Waits.Reached(() => disposed, "the disposal");
        await Task.Delay(TimeSpan.FromMilliseconds(300));

        lock (log) Assert.DoesNotContain(log, entry => entry.Message.Contains("failed unexpectedly", StringComparison.Ordinal));
    }

    [Fact]
    public void AHandOverThatValidatesCleanly_ClearsTheFailureAnEarlierHandOverSet()
    {
        var faults = new InMemoryNotificationPublisher { FaultsOn = IsRowsChanged };
        using var faulting = Indexes.Reconciled(_fixture, InstanceRootNamed("faulting"), notifications: faults);
        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved\""))]);
        Waits.Reached(() => faulting.Status.State == LoadOrderState.Failed, "the failed status");

        faults.FaultsOn = null;
        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedAgain\""))]);

        Waits.Reached(() => faulting.Status.State == LoadOrderState.Ready, "the ready status");
        Assert.Equal("TypedAgain", faulting.DocumentOf(_npc, _compiledPlugin.Key).EditorId);
    }

    [Fact]
    public void AHandOverWhoseStatusCannotBePublished_LeavesTheNextHandOverValidated()
    {
        var faults = new InMemoryNotificationPublisher();
        using var faulting = Indexes.Reconciled(_fixture, InstanceRootNamed("faulting"), notifications: faults);
        var validationFault = Faults.Of(typeof(InvalidOperationException));
        faults.OnPublish = Faults.On(IsRowsChanged, validationFault)
            + Faults.On(n => n is LoadOrderStatusNotification, Faults.Of(typeof(NotSupportedException)));
        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedUnsaved\""))]);
        Waits.Reached(() => faulting.Status.Message?.Contains(validationFault.Message, StringComparison.Ordinal) == true, "the validation fault in the status");

        faults.OnPublish = null;
        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"CompiledPluginNpc\"", "\"TypedAgain\""))]);

        Waits.Reached(() => faulting.Status.State == LoadOrderState.Ready, "the ready status");
        Assert.Equal("TypedAgain", faulting.DocumentOf(_npc, _compiledPlugin.Key).EditorId);
    }

    [Fact]
    public void AHandOverThatValidatesCleanly_LeavesAFailureTheReconcileSet()
    {
        var faults = new InMemoryNotificationPublisher { FaultsOn = IsRowsChanged };
        using var faulting = Indexes.Reconciled(_fixture, InstanceRootNamed("faulting"), notifications: faults);
        _compiledPlugin.HandEdit(faulting.DocumentOf(_npc, _compiledPlugin.Key), "\"CompiledPluginNpc\"", "\"EditedOnDisk\"");
        faulting.Holder.Apply(faulting.Holder.Current);
        Waits.Reached(() => faulting.Status.State == LoadOrderState.Failed, "the reconcile's failed status");

        faults.FaultsOn = null;
        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"EditedOnDisk\"", "\"TypedUnsaved\""))]);
        Waits.Reached(() => faults.Notifications.Any(RowsChanged(_npc).Invoke), "the hand-over's rows-changed");

        Assert.Equal(LoadOrderState.Failed, faulting.Status.State);
    }

    private static bool IsRowsChanged(INotification notification) => notification is RowsChangedNotification;

    [Fact]
    public void AHandedDocumentsLinkToAMissingRecord_IsAProblemOnItsFile()
    {
        Hand(new DocumentChange(_file, Typed(_race, Absent)));

        var problems = _index.Queries.GetProblems().Value().Single(p => p.Plugin.Name == CompiledPlugin).Problems;
        Assert.Contains(problems, problem => problem.TargetFormKey == Absent
            && Path.Combine(_compiledPlugin.ModFolderOf(), problem.SourceRelativePath) == _file);
    }
}
