using MEditService.Index.Tests.TestSupport;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
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

    private void Hand(params DocumentChange[] documents)
    {
        var before = _notifications.Notifications.Count;
        _index.Unsaved.Apply(documents);
        Waits.Reached(() => _notifications.Since(before).Any(n => RowsChanged(_npc)(n)), "the hand-over's rows-changed");
    }

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
