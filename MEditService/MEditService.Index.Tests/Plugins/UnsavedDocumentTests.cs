using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using static MEditService.Index.Tests.TestSupport.Announcements;

namespace MEditService.Index.Tests.Plugins;

public sealed class UnsavedDocumentTests : IDisposable
{
    private const string Tracked = "Tracked.esp";
    private const string Absent = "000ABC:Absent.esp";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _tracked;
    private readonly string _npc;
    private readonly string _race;
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly OpenedIndex _index;
    private readonly string _file;

    public UnsavedDocumentTests()
    {
        (FormKey npc, FormKey race) = (default, default);
        _fixture = new PluginFixtureBuilder("unsaved-document")
            .WithPlugin(Tracked, mod =>
            {
                race = mod.Races.AddNew("PresentRace").FormKey;
                var added = mod.Npcs.AddNew("TrackedNpc");
                added.Race.SetTo(race);
                npc = added.FormKey;
            }, origin: "TrackedMod")
            .BuildScattered();
        _tracked = _fixture.Plugins.Single(p => p.Name == Tracked);
        (_npc, _race) = (npc.ToString(), race.ToString());
        TrackedMods.Track(_tracked, _fixture.GameDirectory);
        _index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, notifications: _notifications);
        _file = _tracked.SourceFileOf(_index.DocumentOf(_npc, _tracked.KeyOf()));
    }

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

    private string Relative(string path) => Path.GetRelativePath(_tracked.ModFolderOf(), path);

    private PluginProblems ProblemsOfTracked() => _index.Problems.GetProblems().Single(p => p.Plugin.Name == Tracked);

    private IReadOnlyList<SourceProblem>? LaterReadFailureOfTracked() => LaterReadFailureOf(_index);

    private IReadOnlyList<SourceProblem>? LaterReadFailureOf(OpenedIndex index) =>
        (index.PluginRowOf(_tracked.KeyOf()) ?? throw new InvalidOperationException($"Expected a row for {Tracked}.")).LaterReadFailure;

    [Fact]
    public void AHandedDocument_IsReadInPlaceOfItsFile()
    {
        Hand(new DocumentChange(_file, Typed("\"TrackedNpc\"", "\"TypedUnsaved\"")));

        Assert.Equal("TypedUnsaved", _index.DocumentOf(_npc, _tracked.KeyOf()).EditorId);
    }

    [Fact]
    public void ADroppedDocument_IsReadFromItsFileAgain()
    {
        Hand(new DocumentChange(_file, Typed("\"TrackedNpc\"", "\"TypedUnsaved\"")));

        Hand();

        Assert.Equal("TrackedNpc", _index.DocumentOf(_npc, _tracked.KeyOf()).EditorId);
    }

    [Fact]
    public void AHandedDocumentThatDoesNotRead_LeavesTheLastGoodRows_AndSaysWhy()
    {
        Hand(new DocumentChange(_file, Typed("\"TrackedNpc\"", "\"TypedUnsaved\"")));

        HandUntil(PluginChanged(_tracked), new DocumentChange(_file, Typed("\"TrackedNpc\"", "\"TypedUnsaved")));

        Assert.Equal("TypedUnsaved", _index.DocumentOf(_npc, _tracked.KeyOf()).EditorId);
        Assert.True(_index.ReadFromItsPluginSource(_tracked.KeyOf()));
        var stop = Assert.Single(LaterReadFailureOfTracked() ?? []);
        Assert.Equal(Relative(_file), stop.SourceRelativePath);
        Assert.Contains("is no record document", stop.Message, StringComparison.Ordinal);
        var problems = ProblemsOfTracked();
        Assert.Contains(stop.Message, problems.Failure, StringComparison.Ordinal);
        Assert.Contains(problems.Problems, problem => problem.SourceRelativePath == stop.SourceRelativePath && problem.Message == stop.Message);
    }

    [Fact]
    public void AFailedReadWhoseReasonChangesAsITypeOn_IsOneLineInTheLog()
    {
        var log = new List<LogEntry>();
        using var loggers = LoggerFactory.Create(b => b.AddProvider(new CollectingLoggerProvider(log)));
        var notifications = new InMemoryNotificationPublisher();
        using var logged = Indexes.Reconciled(_fixture, Path.Combine(_fixture.InstanceRoot, "logged"), loggerFactory: loggers, notifications: notifications);

        foreach (var typed in new[] { Typed("\"TrackedNpc\"", "\"TypedUnsaved"), Typed("\"TrackedNpc\"", "\"TrackedNpc\",,") })
        {
            var before = notifications.Notifications.Count;
            logged.Unsaved.Apply([new DocumentChange(_file, typed)]);
            Waits.Reached(() => notifications.Since(before).Any(n => PluginChanged(_tracked)(n)), "the failed read announced");
        }

        lock (log) Assert.Single(log, entry => entry.Level == LogLevel.Warning && entry.Message.Contains(Relative(_file), StringComparison.Ordinal));
    }

    [Fact]
    public void AHandedDocumentThatReadsAgain_ClearsTheFailure_AndRefreshesItsRecord()
    {
        HandUntil(PluginChanged(_tracked), new DocumentChange(_file, Typed("\"TrackedNpc\"", "\"TypedUnsaved")));

        Hand(new DocumentChange(_file, Typed("\"TrackedNpc\"", "\"TypedAgain\"")));

        Assert.Equal("TypedAgain", _index.DocumentOf(_npc, _tracked.KeyOf()).EditorId);
        Assert.Null(ProblemsOfTracked().Failure);
        Assert.Null(LaterReadFailureOfTracked());
    }

    [Fact]
    public void AHandedDocumentThatDoesNotRead_WhenTheIndexOpens_LeavesTheRowsItHeld()
    {
        _index.Dispose();
        var holder = new LoadOrderHolder();
        using var reopened = Indexes.Open(holder);
        reopened.Unsaved.Apply([new DocumentChange(_file, Typed("\"TrackedNpc\"", "\"TypedUnsaved"))]);

        reopened.Reconcile(holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.True(reopened.ReadFromItsPluginSource(_tracked.KeyOf()));
        Assert.Equal(Relative(_file), Assert.Single(LaterReadFailureOf(reopened) ?? []).SourceRelativePath);
    }

    [Fact]
    public void TheSameTextOnDisk_ReadsItsPluginFile()
    {
        File.WriteAllText(_file, Typed("\"TrackedNpc\"", "\"TypedUnsaved"));

        _index.NextSnapshotUntil(() => _index.ReadFromItsPluginFileForItsUnreadableSource(_tracked.KeyOf()), "the binary read in the tree's place");

        Assert.Null(LaterReadFailureOfTracked());
    }

    [Fact]
    public void AHandedDocumentClaimingAnotherRecordsFormKey_LeavesTheLastGoodRows_AndSaysWhy()
    {
        Hand(new DocumentChange(_file, Typed("\"TrackedNpc\"", "\"TypedUnsaved\"")));

        HandUntil(PluginChanged(_tracked), new DocumentChange(_file, Typed("\"TrackedNpc\"", "\"TypedUnsaved\"").Replace(_npc, _race, StringComparison.Ordinal)));

        Assert.Equal("TypedUnsaved", _index.DocumentOf(_npc, _tracked.KeyOf()).EditorId);
        Assert.True(_index.ReadFromItsPluginSource(_tracked.KeyOf()));
        Assert.Contains(LaterReadFailureOfTracked() ?? [], stop => stop.SourceRelativePath == Relative(_file) && stop.FormKey == _race);
    }

    [Fact]
    public void TheSameClaimOnDisk_ReadsItsPluginFile()
    {
        File.WriteAllText(_file, Typed(_npc, _race));

        _index.NextSnapshotUntil(() => _index.ReadFromItsPluginFileForItsUnreadableSource(_tracked.KeyOf()), "the binary read in the tree's place");

        Assert.Null(LaterReadFailureOfTracked());
    }

    [Fact]
    public void AHandOverWhoseValidationFaultsOutright_FailsTheStatus()
    {
        using var faulting = Indexes.Reconciled(
            _fixture, Path.Combine(_fixture.InstanceRoot, "faulting"), notifications: new RowsChangedFaults());

        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"TrackedNpc\"", "\"TypedUnsaved\""))]);

        Waits.Reached(() => faulting.Status.State == LoadOrderState.Failed, "the failed status");
        Assert.Contains(RowsChangedFaults.Reason, faulting.Status.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AHandOverThatValidatesCleanly_ClearsTheFailureAnEarlierHandOverSet()
    {
        var faults = new RowsChangedFaults();
        using var faulting = Indexes.Reconciled(_fixture, Path.Combine(_fixture.InstanceRoot, "faulting"), notifications: faults);
        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"TrackedNpc\"", "\"TypedUnsaved\""))]);
        Waits.Reached(() => faulting.Status.State == LoadOrderState.Failed, "the failed status");

        faults.Faulting = false;
        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"TrackedNpc\"", "\"TypedAgain\""))]);

        Waits.Reached(() => faulting.Status.State == LoadOrderState.Ready, "the ready status");
        Assert.Equal("TypedAgain", faulting.DocumentOf(_npc, _tracked.KeyOf()).EditorId);
    }

    [Fact]
    public void AHandOverThatValidatesCleanly_LeavesAFailureTheReconcileSet()
    {
        var faults = new RowsChangedFaults();
        using var faulting = Indexes.Reconciled(_fixture, Path.Combine(_fixture.InstanceRoot, "faulting"), notifications: faults);
        _tracked.HandEdit(faulting.DocumentOf(_npc, _tracked.KeyOf()), "\"TrackedNpc\"", "\"EditedOnDisk\"");
        faulting.Holder.Apply(faulting.Holder.Current);
        Waits.Reached(() => faulting.Status.State == LoadOrderState.Failed, "the reconcile's failed status");

        faults.Faulting = false;
        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"EditedOnDisk\"", "\"TypedUnsaved\""))]);
        Waits.Reached(() => faults.Announced(RowsChanged(_npc)), "the hand-over's rows-changed");

        Assert.Equal(LoadOrderState.Failed, faulting.Status.State);
    }

    private sealed class RowsChangedFaults : INotificationPublisher
    {
        public const string Reason = "the stream could not take the push";

        private readonly InMemoryNotificationPublisher _published = new();

        public bool Faulting { get; set; } = true;

        public bool Announced(Predicate<INotification> announced) => _published.Notifications.Any(n => announced(n));

        public void Publish(INotification notification)
        {
            if (Faulting && notification is RowsChangedNotification) throw new InvalidOperationException(Reason);
            _published.Publish(notification);
        }
    }

    [Fact]
    public void AHandedDocumentsLinkToAMissingRecord_IsAProblemOnItsFile()
    {
        Hand(new DocumentChange(_file, Typed(_race, Absent)));

        var problems = _index.Problems.GetProblems().Single(p => p.Plugin.Name == Tracked).Problems;
        Assert.Contains(problems, problem => problem.TargetFormKey == Absent
            && Path.Combine(_tracked.ModFolderOf(), problem.SourceRelativePath) == _file);
    }
}
