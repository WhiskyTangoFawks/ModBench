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
    private const string SourcePlugin = "SourcePlugin.esp";
    private const string Absent = "000ABC:Absent.esp";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _sourcePlugin;
    private readonly string _npc;
    private readonly string _race;
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly OpenedIndex _index;
    private readonly string _file;

    public UnsavedDocumentTests()
    {
        (FormKey npc, FormKey race) = (default, default);
        _fixture = new PluginFixtureBuilder("unsaved-document")
            .WithPlugin(SourcePlugin, mod =>
            {
                race = mod.Races.AddNew("PresentRace").FormKey;
                var added = mod.Npcs.AddNew("SourcePluginNpc");
                added.Race.SetTo(race);
                npc = added.FormKey;
            }, origin: "SourceMod")
            .BuildScattered();
        _sourcePlugin = _fixture.Plugins.Single(p => p.Name == SourcePlugin);
        (_npc, _race) = (npc.ToString(), race.ToString());
        SourceMods.Track(_sourcePlugin);
        _index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, notifications: _notifications);
        _file = _sourcePlugin.SourceFileOf(_index.DocumentOf(_npc, _sourcePlugin.KeyOf()));
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

    private string Relative(string path) => Path.GetRelativePath(_sourcePlugin.ModFolderOf(), path);

    private PluginProblems ProblemsOfSourcePlugin() => _index.Queries.GetProblems().Value().Single(p => p.Plugin.Name == SourcePlugin);

    private IReadOnlyList<SourceProblem>? LaterReadFailureOfSourcePlugin() => LaterReadFailureOf(_index);

    private IReadOnlyList<SourceProblem>? LaterReadFailureOf(OpenedIndex index) =>
        (index.PluginRowOf(_sourcePlugin.KeyOf()) ?? throw new InvalidOperationException($"Expected a row for {SourcePlugin}.")).LaterReadFailure;

    [Fact]
    public void AHandedDocument_IsReadInPlaceOfItsFile()
    {
        Hand(new DocumentChange(_file, Typed("\"SourcePluginNpc\"", "\"TypedUnsaved\"")));

        Assert.Equal("TypedUnsaved", _index.DocumentOf(_npc, _sourcePlugin.KeyOf()).EditorId);
    }

    [Fact]
    public void ADroppedDocument_IsReadFromItsFileAgain()
    {
        Hand(new DocumentChange(_file, Typed("\"SourcePluginNpc\"", "\"TypedUnsaved\"")));

        Hand();

        Assert.Equal("SourcePluginNpc", _index.DocumentOf(_npc, _sourcePlugin.KeyOf()).EditorId);
    }

    [Fact]
    public void AHandedDocumentThatDoesNotRead_LeavesTheLastGoodRows_AndSaysWhy()
    {
        Hand(new DocumentChange(_file, Typed("\"SourcePluginNpc\"", "\"TypedUnsaved\"")));

        HandUntil(PluginChanged(_sourcePlugin), new DocumentChange(_file, Typed("\"SourcePluginNpc\"", "\"TypedUnsaved")));

        Assert.Equal("TypedUnsaved", _index.DocumentOf(_npc, _sourcePlugin.KeyOf()).EditorId);
        Assert.True(_index.ReadFromItsPluginSource(_sourcePlugin.KeyOf()));
        var stop = Assert.Single(LaterReadFailureOfSourcePlugin() ?? []);
        Assert.Equal(Relative(_file), stop.SourceRelativePath);
        Assert.Contains("is no record document", stop.Message, StringComparison.Ordinal);
        var problems = ProblemsOfSourcePlugin();
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
        using var logged = Indexes.Reconciled(_fixture, Path.Combine(_fixture.InstanceRoot, "logged"), loggerFactory: loggers, notifications: notifications);

        foreach (var typed in new[] { Typed("\"SourcePluginNpc\"", "\"TypedUnsaved"), Typed("\"SourcePluginNpc\"", "\"SourcePluginNpc\",,") })
        {
            var before = notifications.Notifications.Count;
            logged.Unsaved.Apply([new DocumentChange(_file, typed)]);
            Waits.Reached(() => notifications.Since(before).Any(n => PluginChanged(_sourcePlugin)(n)), "the failed read announced");
        }

        lock (log) Assert.Single(log, entry => entry.Level == LogLevel.Warning && entry.Message.Contains(Relative(_file), StringComparison.Ordinal));
    }

    [Fact]
    public void AHandedDocumentThatReadsAgain_ClearsTheFailure_AndRefreshesItsRecord()
    {
        HandUntil(PluginChanged(_sourcePlugin), new DocumentChange(_file, Typed("\"SourcePluginNpc\"", "\"TypedUnsaved")));

        Hand(new DocumentChange(_file, Typed("\"SourcePluginNpc\"", "\"TypedAgain\"")));

        Assert.Equal("TypedAgain", _index.DocumentOf(_npc, _sourcePlugin.KeyOf()).EditorId);
        Assert.Null(ProblemsOfSourcePlugin().Failure);
        Assert.Null(LaterReadFailureOfSourcePlugin());
    }

    [Fact]
    public void AHandedDocumentThatDoesNotRead_WhenTheIndexOpens_LeavesTheRowsItHeld()
    {
        _index.Dispose();
        var holder = new LoadOrderHolder();
        using var reopened = Indexes.Open(holder);
        reopened.Unsaved.Apply([new DocumentChange(_file, Typed("\"SourcePluginNpc\"", "\"TypedUnsaved"))]);

        reopened.Reconcile(holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.True(reopened.ReadFromItsPluginSource(_sourcePlugin.KeyOf()));
        Assert.Equal(Relative(_file), Assert.Single(LaterReadFailureOf(reopened) ?? []).SourceRelativePath);
    }

    [Fact]
    public void TheSameTextOnDisk_ReadsItsPluginFile()
    {
        File.WriteAllText(_file, Typed("\"SourcePluginNpc\"", "\"TypedUnsaved"));

        _index.NextSnapshotUntil(() => _index.ReadFromItsPluginFileForItsUnreadableSource(_sourcePlugin.KeyOf()), "the binary read in the tree's place");

        Assert.Null(LaterReadFailureOfSourcePlugin());
    }

    [Fact]
    public void AHandedDocumentClaimingAnotherRecordsFormKey_LeavesTheLastGoodRows_AndSaysWhy()
    {
        Hand(new DocumentChange(_file, Typed("\"SourcePluginNpc\"", "\"TypedUnsaved\"")));

        HandUntil(PluginChanged(_sourcePlugin), new DocumentChange(_file, Typed("\"SourcePluginNpc\"", "\"TypedUnsaved\"").Replace(_npc, _race, StringComparison.Ordinal)));

        Assert.Equal("TypedUnsaved", _index.DocumentOf(_npc, _sourcePlugin.KeyOf()).EditorId);
        Assert.True(_index.ReadFromItsPluginSource(_sourcePlugin.KeyOf()));
        Assert.Contains(LaterReadFailureOfSourcePlugin() ?? [], stop => stop.SourceRelativePath == Relative(_file) && stop.FormKey == _race);
    }

    [Fact]
    public void TheSameClaimOnDisk_ReadsItsPluginFile()
    {
        File.WriteAllText(_file, Typed(_npc, _race));

        _index.NextSnapshotUntil(() => _index.ReadFromItsPluginFileForItsUnreadableSource(_sourcePlugin.KeyOf()), "the binary read in the tree's place");

        Assert.Null(LaterReadFailureOfSourcePlugin());
    }

    [Theory]
    [InlineData(typeof(InvalidOperationException))]
    [InlineData(typeof(OutOfMemoryException))]
    [InlineData(typeof(OperationCanceledException))]
    public void AHandOverWhoseValidationFaultsOutright_FailsTheStatus(Type thrownType)
    {
        var thrown = Faults.Of(thrownType);
        using var faulting = Indexes.Reconciled(
            _fixture, Path.Combine(_fixture.InstanceRoot, "faulting"), notifications: new InMemoryNotificationPublisher { OnPublish = Faults.On(IsRowsChanged, thrown) });

        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"SourcePluginNpc\"", "\"TypedUnsaved\""))]);

        Waits.Reached(() => faulting.Status.State == LoadOrderState.Failed, "the failed status");
        Assert.Contains(thrown.Message, faulting.Status.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AHandOverThatValidatesCleanly_ClearsTheFailureAnEarlierHandOverSet()
    {
        var faults = new InMemoryNotificationPublisher { FaultsOn = IsRowsChanged };
        using var faulting = Indexes.Reconciled(_fixture, Path.Combine(_fixture.InstanceRoot, "faulting"), notifications: faults);
        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"SourcePluginNpc\"", "\"TypedUnsaved\""))]);
        Waits.Reached(() => faulting.Status.State == LoadOrderState.Failed, "the failed status");

        faults.FaultsOn = null;
        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"SourcePluginNpc\"", "\"TypedAgain\""))]);

        Waits.Reached(() => faulting.Status.State == LoadOrderState.Ready, "the ready status");
        Assert.Equal("TypedAgain", faulting.DocumentOf(_npc, _sourcePlugin.KeyOf()).EditorId);
    }

    [Fact]
    public void AHandOverWhoseStatusCannotBePublished_LeavesTheNextHandOverValidated()
    {
        var faults = new InMemoryNotificationPublisher();
        using var faulting = Indexes.Reconciled(_fixture, Path.Combine(_fixture.InstanceRoot, "faulting"), notifications: faults);
        var publishFault = Faults.Of(typeof(NotSupportedException));
        faults.OnPublish = Faults.On(IsRowsChanged, Faults.Of(typeof(InvalidOperationException)))
            + Faults.On(n => n is LoadOrderStatusNotification, publishFault);
        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"SourcePluginNpc\"", "\"TypedUnsaved\""))]);
        Waits.Reached(() => faulting.Status.Message?.Contains(publishFault.Message, StringComparison.Ordinal) == true, "the publish fault in the status");

        faults.OnPublish = null;
        faulting.Unsaved.Apply([new DocumentChange(_file, Typed("\"SourcePluginNpc\"", "\"TypedAgain\""))]);

        Waits.Reached(() => faulting.Status.State == LoadOrderState.Ready, "the ready status");
        Assert.Equal("TypedAgain", faulting.DocumentOf(_npc, _sourcePlugin.KeyOf()).EditorId);
    }

    [Fact]
    public void AHandOverThatValidatesCleanly_LeavesAFailureTheReconcileSet()
    {
        var faults = new InMemoryNotificationPublisher { FaultsOn = IsRowsChanged };
        using var faulting = Indexes.Reconciled(_fixture, Path.Combine(_fixture.InstanceRoot, "faulting"), notifications: faults);
        _sourcePlugin.HandEdit(faulting.DocumentOf(_npc, _sourcePlugin.KeyOf()), "\"SourcePluginNpc\"", "\"EditedOnDisk\"");
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

        var problems = _index.Queries.GetProblems().Value().Single(p => p.Plugin.Name == SourcePlugin).Problems;
        Assert.Contains(problems, problem => problem.TargetFormKey == Absent
            && Path.Combine(_sourcePlugin.ModFolderOf(), problem.SourceRelativePath) == _file);
    }
}
