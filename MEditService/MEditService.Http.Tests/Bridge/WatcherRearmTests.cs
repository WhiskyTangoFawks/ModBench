using System.Diagnostics;
using MEditService.Ports;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using MEditService.Watcher;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Bridge;

/// <summary>A binary changed with no watcher running is caught at the next reconcile, through the
/// same "a tracked mod settled" verb the live watcher sends.</summary>
public sealed class WatcherRearmTests : IDisposable
{
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private ModFolderWatcher Watching(TimeSpan? quiet = null) =>
        TestWatcher.Over(_mod.Holder, _mod.Index, _notifications, quiet);

    [Fact]
    public void Rearm_QueuesAnExternalChange_ForABinaryThatChangedWithNoWatcherEverRunning()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName);

        // "Closed" means no FileSystemWatcher instance ever sees this write happen.
        var externalMod = new Fallout4Mod(ModKey.FromFileName(IndexedModFixture.PluginName), Fallout4Release.Fallout4);
        var race = externalMod.Races.AddNew("FixtureRace");
        externalMod.Keywords.AddNew("FixtureKeyword");
        var npc = externalMod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        npc.HeightMax = 0.9f;
        externalMod.Npcs.AddNew("UntouchedNpc");
        externalMod.WriteToBinary(pluginPath);

        using var watcher = Watching();
        watcher.Rearm(_mod.Holder.Current);

        var question = SourceRepository.UnansweredExternalChange(_mod.ModFolder);
        Assert.NotNull(question);
        Assert.Contains(IndexedModFixture.PluginName, question, StringComparison.Ordinal);
        var pending = Assert.Single(_notifications.Notifications.OfType<QuestionOpenNotification>());
        Assert.Equal([IndexedModFixture.PluginName], pending.Plugins);
    }

    // The question reaches the front end as one notification, and the origin on it is the load
    // order's, since the watch itself carries only the bare mod folder.
    [Fact]
    public void Rearm_PublishesTheQuestionOnce_WithTheOriginResolvedFromTheHolder()
    {
        File.WriteAllBytes(Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName), "changed-by-xedit"u8.ToArray());

        using var watcher = Watching();
        watcher.Rearm(_mod.Holder.Current);

        var pending = Assert.Single(_notifications.Notifications.OfType<QuestionOpenNotification>());
        Assert.Equal(IndexedModFixture.ModFolderOrigin, pending.Origin);
        Assert.Equal([IndexedModFixture.PluginName], pending.Plugins);
    }

    // The live half of the same route: one settle over a tracked mod is one classification and one
    // question, and the origin on it is the load order's.
    [Fact]
    public void ALiveSettle_PublishesTheQuestionOnce_WithTheOriginResolvedFromTheHolder()
    {
        using var watcher = Watching(TimeSpan.FromMilliseconds(100));
        watcher.Rearm(_mod.Holder.Current);
        Assert.Empty(_notifications.Notifications);

        File.WriteAllBytes(Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName), "changed-by-xedit"u8.ToArray());

        var elapsed = Stopwatch.StartNew();
        while (elapsed.Elapsed < TimeSpan.FromSeconds(3) && _notifications.Notifications.Count == 0) Thread.Sleep(20);
        // Past the quiet window, so a second settle would have landed its own question by now.
        Thread.Sleep(400);

        var pending = Assert.Single(_notifications.Notifications.OfType<QuestionOpenNotification>());
        Assert.Equal(IndexedModFixture.ModFolderOrigin, pending.Origin);
        Assert.Equal([IndexedModFixture.PluginName], pending.Plugins);
    }

    // ADR-0015 invariant 2: a restart's classify and a live change's classify are the same call in
    // Commands, so the two ask the identical question.
    [Fact]
    public void ARestartAndALiveChange_PublishTheIdenticalQuestion()
    {
        File.WriteAllBytes(Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName), "changed-by-xedit"u8.ToArray());
        using var restarted = Watching();
        restarted.Rearm(_mod.Holder.Current);
        var fromRestart = Assert.Single(_notifications.Notifications.OfType<QuestionOpenNotification>());

        using var live = IndexedModFixture.Tracked();
        var liveNotifications = new InMemoryNotificationPublisher();
        using var liveWatcher = TestWatcher.Over(live.Holder, live.Index, liveNotifications, TimeSpan.FromMilliseconds(100));
        liveWatcher.Rearm(live.Holder.Current);
        File.WriteAllBytes(Path.Combine(live.ModFolder, IndexedModFixture.PluginName), "changed-by-xedit"u8.ToArray());
        var elapsed = Stopwatch.StartNew();
        while (elapsed.Elapsed < TimeSpan.FromSeconds(3) && liveNotifications.Notifications.Count == 0) Thread.Sleep(20);
        Thread.Sleep(400);
        var fromLiveChange = Assert.Single(liveNotifications.Notifications.OfType<QuestionOpenNotification>());

        Assert.Equal(fromRestart.Plugins, fromLiveChange.Plugins);
        Assert.Equal(fromRestart.TrackedFiles, fromLiveChange.TrackedFiles);
        Assert.Equal(fromRestart.MetaChanged, fromLiveChange.MetaChanged);
        Assert.Equal(fromRestart.OldVersion, fromLiveChange.OldVersion);
        Assert.Equal(fromRestart.NewVersion, fromLiveChange.NewVersion);
    }

    [Fact]
    public void Rearm_QueuesNothing_WhenTheBinaryNeverChanged()
    {
        using var watcher = Watching();

        watcher.Rearm(_mod.Holder.Current);

        Assert.Empty(_notifications.Notifications);
    }

    // The marker outlived its change (bytes restored by hand, a re-Track, a superseding settle):
    // the classifier is the authority, so a load finding nothing drops it rather than leaving the
    // mod read-only over a question nobody can answer.
    [Fact]
    public void Rearm_DropsAStaleMarker_AndQueuesNothing_WhenTheBytesMatchTheParkedSnapshot()
    {
        SourceRepository.RaiseExternalChangeQuestion(_mod.ModFolder, "a question whose change is gone");
        using var watcher = Watching();

        watcher.Rearm(_mod.Holder.Current);

        Assert.Null(SourceRepository.UnansweredExternalChange(_mod.ModFolder));
        Assert.Empty(_notifications.Notifications.OfType<QuestionOpenNotification>());
    }

    // An unreadable binary is a repair offer, and no verdict: the marker it would have cleared stands.
    [Fact]
    public void Rearm_KeepsAStaleMarker_WhenTheTrackedPluginCannotBeRead()
    {
        SourceRepository.RaiseExternalChangeQuestion(_mod.ModFolder, "a question the binary cannot answer for now");
        File.Delete(Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName));
        using var watcher = Watching();

        watcher.Rearm(_mod.Holder.Current);

        var pending = Assert.Single(_notifications.Notifications.OfType<QuestionOpenNotification>());
        Assert.Equal(nameof(CrashRepairReason.MissingOrUnreadableBinary), pending.CrashRepairReason);
        Assert.NotNull(SourceRepository.UnansweredExternalChange(_mod.ModFolder));
    }

    // A crash between the journal's marker write and its clear is offered for repair and never
    // routed into the external-change queue: the two prompts must never both fire for one event.
    [Fact]
    public void Rearm_OffersRepair_AndQueuesNoExternalChangeQuestion_WhenAJournalMarkerIsUnanswered()
    {
        Assert.ThrowsAny<Exception>(() =>
            CompileJournal.RunBatch(_mod.ModFolder, [IndexedModFixture.PluginName],
                _ => throw new InvalidOperationException("simulated crash between source and binary write")));
        Assert.NotNull(CompileJournal.UnfinishedBatch(_mod.ModFolder)); // sanity: the marker really is there.

        using var watcher = Watching();
        watcher.Rearm(_mod.Holder.Current);

        // Assert.Single is also "never both": the repair offer and the external-change dialog's
        // own question must never fire together for one event.
        var pending = Assert.Single(_notifications.Notifications.OfType<QuestionOpenNotification>());
        Assert.Equal(IndexedModFixture.ModFolderOrigin, pending.Origin);
        Assert.Equal([IndexedModFixture.PluginName], pending.Plugins);
        Assert.Equal(nameof(CrashRepairReason.InterruptedCompile), pending.CrashRepairReason);
    }

    // The repo and source survive, only the plugin's own binary is gone — reachable
    // without the repo being destroyed (ADR-0007's "reads as untracked" case is a different, already-
    // handled path).
    [Fact]
    public void Rearm_OffersRepair_WhenTheTrackedPluginsBinaryIsMissing()
    {
        File.Delete(Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName));

        using var watcher = Watching();
        watcher.Rearm(_mod.Holder.Current);

        var pending = Assert.Single(_notifications.Notifications.OfType<QuestionOpenNotification>());
        Assert.Equal(IndexedModFixture.ModFolderOrigin, pending.Origin);
        Assert.Equal([IndexedModFixture.PluginName], pending.Plugins);
        Assert.Equal(nameof(CrashRepairReason.MissingOrUnreadableBinary), pending.CrashRepairReason);
    }

    // TrackedOf's early-continue makes the rest of the re-arm's body unreachable for an untracked
    // plugin, even in the repair-worthy state that offers repair for a tracked one.
    [Fact]
    public void Rearm_OffersNothing_ForAnUntrackedPlugin_EvenWithAMissingBinary()
    {
        using var untracked = IndexedModFixture.Untracked();
        File.Delete(Path.Combine(untracked.ModFolder, IndexedModFixture.PluginName));

        using var watcher = TestWatcher.Over(untracked.Holder, untracked.Index, _notifications);
        watcher.Rearm(untracked.Holder.Current);

        Assert.Empty(_notifications.Notifications.OfType<QuestionOpenNotification>());
    }

    [Fact]
    public void Rearm_RegistersALiveWatch_SoFurtherChangesAreCaughtWithoutAnotherLoad()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName);
        using var watcher = Watching(TimeSpan.FromMilliseconds(100));

        watcher.Rearm(_mod.Holder.Current);
        Assert.Empty(_notifications.Notifications.OfType<QuestionOpenNotification>());

        File.WriteAllBytes(pluginPath, "changed-live-after-load"u8.ToArray());

        var elapsed = Stopwatch.StartNew();
        while (elapsed.Elapsed < TimeSpan.FromSeconds(3) && !_notifications.Notifications.OfType<QuestionOpenNotification>().Any())
            Thread.Sleep(20);

        Assert.Single(_notifications.Notifications.OfType<QuestionOpenNotification>());
    }
}
