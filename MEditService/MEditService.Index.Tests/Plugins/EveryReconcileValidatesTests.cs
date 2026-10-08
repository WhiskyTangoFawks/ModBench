using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Index.Tests.TestSupport.Announcements;

namespace MEditService.Index.Tests.Plugins;

public sealed class EveryReconcileValidatesTests : IDisposable
{

    private const string Untracked = "Untracked.esp";
    private const string Tracked = "Tracked.esp";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _untracked;
    private readonly LoadOrderEntry _tracked;
    private readonly string _trackedNpc;
    private readonly LoadOrderHolder _holder = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly OpenedIndex _index;

    public EveryReconcileValidatesTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("every-reconcile-validates")
            .WithPlugin(Untracked, mod => mod.Npcs.AddNew("UntrackedNpc"), origin: "UntrackedMod")
            .WithPlugin(Tracked, mod => npc = mod.Npcs.AddNew("TrackedNpc").FormKey, origin: "TrackedMod")
            .BuildScattered();
        _untracked = _fixture.Plugins.Single(p => p.Name == Untracked);
        _tracked = _fixture.Plugins.Single(p => p.Name == Tracked);
        _trackedNpc = npc.ToString();
        TrackedMods.Track(_tracked, _fixture.GameDirectory);
        var clock = new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1));
        _index = Indexes.Open(_holder, notifications: _notifications, timeProvider: clock);
        Reconcile();
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private void Reconcile() =>
        _index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

    private void ArrivalAnnouncing(Predicate<INotification> announced)
    {
        var before = _notifications.Notifications.Count;
        _index.NextSnapshotUntil(() => _notifications.Since(before).Any(n => announced(n)), "the arrival's announcement");
    }

    private void HandEditTracked(string editorId = "EditedByHand")
    {
        var document = _index.DocumentOf(_trackedNpc, _tracked.KeyOf());
        _tracked.HandEdit(document, document.EditorId ?? "", editorId);
    }

    private void RewriteUntracked(string editorId)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(Untracked), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        mod.WriteToBinary(_untracked.Path);
    }

    [Fact]
    public void AnEqualSnapshot_ReindexesAnUntrackedBinaryRewrittenOutsideModbench_AndNamesThePlugin()
    {
        RewriteUntracked("WrittenByAnotherTool");

        ArrivalAnnouncing(PluginChanged(_untracked));

        Assert.Contains(_index.ListedIn(_untracked.KeyOf()), row => row.EditorId == "WrittenByAnotherTool");
    }

    [Fact]
    public void AnEqualSnapshot_RefreshesATrackedDocumentEditedOutsideModbench_AndNamesTheRecord()
    {
        HandEditTracked();

        ArrivalAnnouncing(RowsChanged(_trackedNpc));

        Assert.Equal("EditedByHand", _index.DocumentOf(_trackedNpc, _tracked.KeyOf()).EditorId);
    }

    [Fact]
    public void AnEqualSnapshot_TakesTheRowsOfAnUntrackedBinaryGoneFromDisk_AndNamesThePlugin()
    {
        File.Delete(_untracked.Path);

        ArrivalAnnouncing(PluginChanged(_untracked));

        Assert.Empty(_index.ListedIn(_untracked.KeyOf()));
    }

    [Fact]
    public void AnEqualSnapshot_TakesEveryRowOfAPluginWhoseRepositoryAndBinaryWent()
    {
        HandEditTracked();
        ArrivalAnnouncing(RowsChanged(_trackedNpc));

        Directory.Delete(Path.Combine(_tracked.ModFolderOf(), ".git"), recursive: true);
        File.Delete(_tracked.Path);
        ArrivalAnnouncing(PluginChanged(_tracked));

        Assert.Empty(_index.ListedIn(_tracked.KeyOf()));
    }

    [Fact]
    public void AnEqualSnapshot_ReindexesAnUntrackedBinaryThatCameBack()
    {
        var bytes = File.ReadAllBytes(_untracked.Path);
        File.Delete(_untracked.Path);
        ArrivalAnnouncing(PluginChanged(_untracked));
        Assert.Empty(_index.ListedIn(_untracked.KeyOf()));

        File.WriteAllBytes(_untracked.Path, bytes);
        ArrivalAnnouncing(PluginChanged(_untracked));

        Assert.Contains(_index.ListedIn(_untracked.KeyOf()), row => row.EditorId == "UntrackedNpc");
    }

    [Fact]
    public void AnEqualSnapshot_OfABinaryWhoseStampHolds_ReadsNothing()
    {
        using var held = new FileStream(_untracked.Path, FileMode.Open, FileAccess.Read, FileShare.None);
        Assert.Null(PluginBinaryHash.ClaimOfFile(_untracked.Path));

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _tracked.RenamedByHand(_index));

        Assert.All(announced, n => Assert.IsType<RowsChangedNotification>(n));
        Assert.Empty(_index.Status.Failures);
    }

    [Fact]
    public void AnEqualSnapshot_OfAPluginHeldWithAFailure_PublishesNothingWhileItsBytesStayTheSame()
    {
        File.WriteAllText(_untracked.Path, "not a plugin");
        ArrivalAnnouncing(FailureNamed(Untracked));

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _tracked.RenamedByHand(_index));

        Assert.All(announced, n => Assert.IsType<RowsChangedNotification>(n));
    }

    [Fact]
    public void AnEqualSnapshot_OfAPluginWithNoTreeInATrackedMod_PublishesNothing()
    {
        var loosePath = Path.Combine(_tracked.ModFolderOf(), "Loose.esp");
        var loose = new Fallout4Mod(ModKey.FromFileName("Loose.esp"), Fallout4Release.Fallout4);
        loose.Npcs.AddNew("LooseNpc");
        loose.WriteToBinary(loosePath);
        LoadOrderEntry[] plugins = [.. _fixture.Plugins, new("Loose.esp", loosePath, _tracked.Origin, 2, Enabled: true, Winning: true)];
        _index.Reconcile(_holder, _fixture.GameDirectory, plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        Assert.Contains(
            _index.ListedIn(new PluginAddress("Loose.esp", _tracked.Origin)), row => row.EditorId == "LooseNpc");

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _tracked.RenamedByHand(_index));

        Assert.All(announced, n => Assert.IsType<RowsChangedNotification>(n));
    }

    [Fact]
    public void AnEqualSnapshot_OfATreeThatFailedToRead_AndStandsUnchanged_ReadsNothingOfIt()
    {
        var document = _tracked.SourceFileOf(_index.DocumentOf(_trackedNpc, _tracked.KeyOf()));
        File.Copy(document, Path.Combine(Path.GetDirectoryName(document).Require(), "Backup.json"));
        ArrivalAnnouncing(PluginChanged(_tracked));
        Assert.True(_index.ReadFromItsPluginFileForItsUnreadableSource(_tracked.KeyOf()));

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => Touched(_untracked));

        Assert.All(announced, n => Assert.IsType<PluginChangedNotification>(n));
        Assert.DoesNotContain(announced, PluginChanged(_tracked));
        Assert.True(_index.ReadFromItsPluginFileForItsUnreadableSource(_tracked.KeyOf()));
    }

    [Fact]
    public void AnEqualSnapshot_ReadsABinaryThatFailedAgain_OnceItsBytesChange()
    {
        File.WriteAllText(_untracked.Path, "not a plugin");
        ArrivalAnnouncing(FailureNamed(Untracked));

        RewriteUntracked("FixedByAnotherTool");
        ArrivalAnnouncing(PluginChanged(_untracked));

        Assert.Contains(_index.ListedIn(_untracked.KeyOf()), row => row.EditorId == "FixedByAnotherTool");
        Assert.DoesNotContain(_index.Status.Failures, f => f.Name == Untracked);
    }

    [Fact]
    public async Task AnEqualSnapshot_TriesAFailedReconcileAgain()
    {
        var blocker = Path.GetDirectoryName(IndexFiles.In(_fixture.InstanceRoot))
            ?? throw new InvalidOperationException("The index file sits in a folder.");
        _index.Dispose();
        Directory.Delete(blocker, recursive: true);
        File.WriteAllText(blocker, "not a folder");
        var holder = new LoadOrderHolder();
        using var failing = Indexes.Open(holder);
        holder.Apply(_holder.Current);
        Waits.Reached(() => failing.Status.State == LoadOrderState.Failed, "the first arrival's failure");

        File.Delete(blocker);
        failing.NextSnapshotUntil(() => failing.Status.State == LoadOrderState.Ready, "the equal arrival's retry");
        Assert.NotEmpty(failing.ListedIn(_untracked.KeyOf()));
    }

    [Fact]
    public void AnEqualSnapshot_ReadsAPluginWhoseModGainedARepository_FromItsTree()
    {
        TrackedMods.Track(_untracked, _fixture.GameDirectory);

        _index.NextSnapshotUntil(
            () => _index.ReadFromItsPluginSource(_untracked.KeyOf()), "the arrival's re-derivation of the plugin from its tree");
    }
}
