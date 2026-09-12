using MEditService.Commands.Edits;
using MEditService.Ports;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using MEditService.Watcher;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Bridge;

/// <summary>A binary changed while no watcher was running (Modbench closed) is caught when a load
/// order reconciles, through the same classifier the live watcher calls; crash-repair offers are
/// routed away from the external-change dialog's queue.</summary>
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

        var unanswered = Assert.Single(watcher.Unanswered());
        Assert.Equal(_mod.ModFolder, unanswered.ModFolder);
        Assert.Equal([IndexedModFixture.PluginName], unanswered.Classification.Plugins);
    }

    // The question reaches the front end as one notification, and the origin on it is the load
    // order's, since the watch itself carries only the bare mod folder.
    [Fact]
    public void Rearm_PublishesTheQuestionOnce_WithTheOriginResolvedFromTheHolder()
    {
        File.WriteAllBytes(Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName), "changed-by-xedit"u8.ToArray());

        using var watcher = Watching();
        watcher.Rearm(_mod.Holder.Current);

        var pending = Assert.Single(_notifications.Notifications.OfType<ExternalChangePendingNotification>());
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

        var deadline = DateTime.UtcNow.AddSeconds(3);
        while (DateTime.UtcNow < deadline && watcher.Unanswered().Count == 0) Thread.Sleep(20);
        // Past the quiet window, so a second settle would have landed its own question by now.
        Thread.Sleep(400);

        var pending = Assert.Single(_notifications.Notifications.OfType<ExternalChangePendingNotification>());
        Assert.Equal(IndexedModFixture.ModFolderOrigin, pending.Origin);
        Assert.Equal([IndexedModFixture.PluginName], pending.Plugins);
    }

    [Fact]
    public void Rearm_QueuesNothing_WhenTheBinaryNeverChanged()
    {
        using var watcher = Watching();

        var offers = watcher.Rearm(_mod.Holder.Current);

        Assert.Empty(watcher.Unanswered());
        Assert.Empty(offers); // clean state produces no repair activity either.
    }

    // The marker outlived its change (bytes restored by hand, a re-Track, a superseding settle):
    // the classifier is the authority, so a load finding nothing drops it rather than leaving the
    // mod read-only over a question nobody can answer.
    [Fact]
    public void Rearm_DropsAStaleMarker_AndQueuesNothing_WhenTheBytesMatchTheParkedSnapshot()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, "a question whose change is gone");
        using var watcher = Watching();

        watcher.Rearm(_mod.Holder.Current);

        Assert.Null(ExternalChangeDeferral.Unanswered(_mod.ModFolder));
        Assert.Empty(watcher.Unanswered());
    }

    // An unreadable binary is a repair offer, and no verdict: the marker it would have cleared stands.
    [Fact]
    public void Rearm_KeepsAStaleMarker_WhenTheTrackedPluginCannotBeRead()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, "a question the binary cannot answer for now");
        File.Delete(Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName));
        using var watcher = Watching();

        var offers = watcher.Rearm(_mod.Holder.Current);

        Assert.Equal(CrashRepairReason.MissingOrUnreadableBinary, Assert.Single(offers).Reason);
        Assert.NotNull(ExternalChangeDeferral.Unanswered(_mod.ModFolder));
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
        var offers = watcher.Rearm(_mod.Holder.Current);

        var offer = Assert.Single(offers);
        Assert.Equal(IndexedModFixture.PluginName, offer.Plugin);
        Assert.Equal(IndexedModFixture.ModFolderOrigin, offer.Origin);
        Assert.Equal(CrashRepairReason.InterruptedCompile, offer.Reason);
        Assert.Empty(watcher.Unanswered()); // never the external-change dialog's own question.
    }

    // The repo and source survive, only the plugin's own binary is gone — reachable
    // without the repo being destroyed (ADR-0007's "reads as untracked" case is a different, already-
    // handled path).
    [Fact]
    public void Rearm_OffersRepair_WhenTheTrackedPluginsBinaryIsMissing()
    {
        File.Delete(Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName));

        using var watcher = Watching();
        var offers = watcher.Rearm(_mod.Holder.Current);

        var offer = Assert.Single(offers);
        Assert.Equal(IndexedModFixture.PluginName, offer.Plugin);
        Assert.Equal(IndexedModFixture.ModFolderOrigin, offer.Origin);
        Assert.Equal(CrashRepairReason.MissingOrUnreadableBinary, offer.Reason);
        Assert.Empty(watcher.Unanswered());
    }

    // TrackedOf's early-continue makes the rest of the re-arm's body unreachable for an untracked
    // plugin, even in the repair-worthy state that offers repair for a tracked one.
    [Fact]
    public void Rearm_OffersNothing_ForAnUntrackedPlugin_EvenWithAMissingBinary()
    {
        using var untracked = IndexedModFixture.Untracked();
        File.Delete(Path.Combine(untracked.ModFolder, IndexedModFixture.PluginName));

        using var watcher = TestWatcher.Over(untracked.Holder, untracked.Index, _notifications);
        var offers = watcher.Rearm(untracked.Holder.Current);

        Assert.Empty(offers);
        Assert.Empty(watcher.Unanswered());
    }

    [Fact]
    public void Rearm_RegistersALiveWatch_SoFurtherChangesAreCaughtWithoutAnotherLoad()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName);
        using var watcher = Watching(TimeSpan.FromMilliseconds(100));

        watcher.Rearm(_mod.Holder.Current);
        Assert.Empty(watcher.Unanswered());

        File.WriteAllBytes(pluginPath, "changed-live-after-load"u8.ToArray());

        var deadline = DateTime.UtcNow.AddSeconds(3);
        while (DateTime.UtcNow < deadline && watcher.Unanswered().Count == 0) Thread.Sleep(20);

        Assert.Single(watcher.Unanswered());
    }
}
