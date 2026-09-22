using MEditService.SourceRepo;
using MEditService.TestSupport;
using MEditService.Watcher.Tests.TestSupport;

namespace MEditService.Watcher.Tests.Bridge;

/// <summary>The load-time settle, through the verb the live watcher sends. The reconcile follows
/// every settle, so once it is recorded an unopened question never opens.</summary>
public sealed class LoadOrderChangeSettleTests
{
    private const string Origin = "TrackedMod";
    private const string PluginName = "Tracked.esp";
    private const string QuestionOpen = "question-open";

    private static string PluginPath(WatchedTree tree) => Path.Combine(tree.InstanceRoot, "mods", Origin, PluginName);

    // Tracked before any watch runs, with the binary parked as its last compile: the state a
    // service finds at startup.
    private static (WatchedTree Tree, string ModFolder) TrackedBeforeWatching()
    {
        var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, PluginName);
        WatchedTree.Track(modFolder, PluginName);
        return (tree, modFolder);
    }

    private static IReadOnlyList<PublishedNotification> Questions(WatchedTree tree) =>
        [.. tree.Notifications.Published.Where(n => n.Kind == QuestionOpen)];

    [Fact]
    public async Task ABinaryThatChangedWithNoWatcherEverRunning_OpensTheQuestionAtTheNextLoad()
    {
        var (tree, modFolder) = TrackedBeforeWatching();
        using var _ = tree;
        // "Closed" means no FileSystemWatcher instance ever sees this write happen.
        File.WriteAllBytes(PluginPath(tree), "changed-by-xedit"u8.ToArray());

        await tree.ApplyLoadOrder();

        var question = SourceRepository.UnansweredExternalChange(modFolder);
        Assert.NotNull(question);
        Assert.Contains(PluginName, question, StringComparison.Ordinal);
        var pending = Assert.Single(Questions(tree));
        Assert.Equal([PluginName], pending.Keys);
    }

    // The question reaches the front end as one notification, and the origin on it is the load
    // order's, since the watch itself carries only the bare mod folder.
    [Fact]
    public async Task TheQuestionAtLoad_IsPublishedOnce_WithTheOriginTheSnapshotNames()
    {
        var (tree, _) = TrackedBeforeWatching();
        using var __ = tree;
        File.WriteAllBytes(PluginPath(tree), "changed-by-xedit"u8.ToArray());

        await tree.ApplyLoadOrder();

        var pending = Assert.Single(Questions(tree));
        Assert.Equal(Origin, pending.Origin);
        Assert.Equal([PluginName], pending.Keys);
    }

    // The live half of the same route: one settle over a tracked mod is one classification and one
    // question. A second window closing after it is the delivery oracle for "never a second".
    [Fact]
    public async Task ALiveSettle_PublishesTheQuestionOnce_WithTheOriginTheSnapshotNames()
    {
        var (tree, modFolder) = TrackedBeforeWatching();
        using var _ = tree;
        await tree.ApplyLoadOrder();
        Assert.Empty(tree.Notifications.Published);

        await tree.Observes(() => tree.WriteFile(PluginPath(tree), "changed-by-xedit"u8.ToArray()));
        tree.AdvancePastBothWindows();
        Assert.Single(Questions(tree));

        tree.AdvancePastBothWindows();

        var pending = Assert.Single(Questions(tree));
        Assert.Equal(Origin, pending.Origin);
        Assert.Equal([PluginName], pending.Keys);
    }

    // ADR-0015 invariant 2: a restart's classify and a live change's classify are the same call in
    // Commands, so the two ask the identical question.
    [Fact]
    public async Task ARestartAndALiveChange_PublishTheIdenticalQuestion()
    {
        var (restarted, _) = TrackedBeforeWatching();
        using var __ = restarted;
        File.WriteAllBytes(PluginPath(restarted), "changed-by-xedit"u8.ToArray());
        await restarted.ApplyLoadOrder();
        var fromRestart = Assert.Single(Questions(restarted));

        var (live, liveFolder) = TrackedBeforeWatching();
        using var ___ = live;
        await live.ApplyLoadOrder();
        await live.Observes(() => live.WriteFile(PluginPath(live), "changed-by-xedit"u8.ToArray()));
        live.AdvancePastBothWindows();
        var fromLiveChange = Assert.Single(Questions(live));

        Assert.Equal(Origin, fromRestart.Origin);
        Assert.Equal(Origin, fromLiveChange.Origin);
        Assert.Equal(fromRestart.Keys, fromLiveChange.Keys);
        Assert.Equal(fromRestart.TrackedFiles, fromLiveChange.TrackedFiles);
        Assert.Equal(fromRestart.MetaChanged, fromLiveChange.MetaChanged);
        Assert.Equal(fromRestart.OldVersion, fromLiveChange.OldVersion);
        Assert.Equal(fromRestart.NewVersion, fromLiveChange.NewVersion);
        Assert.Equal(fromRestart.CrashRepairReason, fromLiveChange.CrashRepairReason);
    }

    [Fact]
    public async Task ALoad_PublishesNothing_WhenTheBinaryNeverChanged()
    {
        var (tree, _) = TrackedBeforeWatching();
        using var __ = tree;

        await tree.ApplyLoadOrder();

        Assert.Empty(tree.Notifications.Published);
    }

    // The marker outlived its change (bytes restored by hand, a re-Track, a superseding settle):
    // the classifier is the authority, so a load finding nothing drops it.
    [Fact]
    public async Task ALoad_DropsAStaleMarker_AndPublishesNothing_WhenTheBytesMatchTheParkedCompile()
    {
        var (tree, modFolder) = TrackedBeforeWatching();
        using var _ = tree;
        SourceRepository.RaiseExternalChangeQuestion(modFolder, "a question whose change is gone");

        await tree.ApplyLoadOrder();

        Assert.Null(SourceRepository.UnansweredExternalChange(modFolder));
        Assert.Empty(Questions(tree));
    }

    // An unreadable binary is a repair offer, and no verdict: the marker it would have cleared stands.
    [Fact]
    public async Task ALoad_KeepsAStaleMarker_WhenTheTrackedPluginCannotBeRead()
    {
        var (tree, modFolder) = TrackedBeforeWatching();
        using var _ = tree;
        SourceRepository.RaiseExternalChangeQuestion(modFolder, "a question the binary cannot answer for now");
        File.Delete(PluginPath(tree));

        await tree.ApplyLoadOrder();

        var pending = Assert.Single(Questions(tree));
        Assert.Equal("MissingOrUnreadableBinary", pending.CrashRepairReason);
        Assert.NotNull(SourceRepository.UnansweredExternalChange(modFolder));
    }

    // A crash between the journal's marker write and its clear is offered for repair and never
    // routed into the external-change queue: the two prompts must never both fire for one event.
    [Fact]
    public async Task ALoad_OffersRepair_AndOpensNoExternalChangeQuestion_WhenAJournalMarkerIsUnanswered()
    {
        var (tree, modFolder) = TrackedBeforeWatching();
        using var _ = tree;
        await Assert.ThrowsAnyAsync<Exception>(() =>
            CompileJournal.RunBatchAsync(modFolder, [PluginName],
                __ => throw new InvalidOperationException("simulated crash between source and binary write")));
        Assert.NotNull(CompileJournal.UnfinishedBatch(modFolder));

        await tree.ApplyLoadOrder();

        // Assert.Single is also "never both": the repair offer and the external-change dialog's
        // own question must never fire together for one event.
        var pending = Assert.Single(Questions(tree));
        Assert.Equal(Origin, pending.Origin);
        Assert.Equal([PluginName], pending.Keys);
        Assert.Equal("InterruptedCompile", pending.CrashRepairReason);
    }

    // The repo and source survive, only the plugin's own binary is gone.
    [Fact]
    public async Task ALoad_OffersRepair_WhenTheTrackedPluginsBinaryIsMissing()
    {
        var (tree, _) = TrackedBeforeWatching();
        using var __ = tree;
        File.Delete(PluginPath(tree));

        await tree.ApplyLoadOrder();

        var pending = Assert.Single(Questions(tree));
        Assert.Equal(Origin, pending.Origin);
        Assert.Equal([PluginName], pending.Keys);
        Assert.Equal("MissingOrUnreadableBinary", pending.CrashRepairReason);
    }

    // An untracked plugin takes the indexed-binary route and never the settle, even in the
    // repair-worthy state that offers repair for a tracked one.
    [Fact]
    public async Task ALoad_OffersNothing_ForAnUntrackedPlugin_EvenWithAMissingBinary()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod("Untracked", PluginName);
        File.Delete(WatchedTree.PluginPath(modFolder, PluginName));

        await tree.ApplyLoadOrder();

        Assert.Empty(tree.Notifications.Published);
    }

    [Fact]
    public async Task ALoad_ArmsALiveWatch_SoFurtherChangesAreCaughtWithoutAnotherLoad()
    {
        var (tree, _) = TrackedBeforeWatching();
        using var __ = tree;
        await tree.ApplyLoadOrder();
        Assert.Empty(Questions(tree));

        await tree.Observes(() => tree.WriteFile(PluginPath(tree), "changed-live-after-load"u8.ToArray()));

        tree.AdvancePastBothWindows();

        Assert.Single(Questions(tree));
        Assert.Single(tree.Index.Reconciles);
    }

    // The rival this pins: a re-arm that forgets the registrations but keeps the folder's watch,
    // so a mod the load order dropped still settles into Commands and asks a question with no
    // origin to put on it.
    [Fact]
    public async Task ATrackedModDroppedFromTheLoadOrder_RaisesNoQuestion_WhenItsFilesChange()
    {
        var (tree, droppedFolder) = TrackedBeforeWatching();
        using var _ = tree;
        var keptFolder = tree.AddMod("KeptMod", "Kept.esp");
        WatchedTree.Track(keptFolder, "Kept.esp");
        await tree.ApplyLoadOrder();

        tree.RemoveCopy(PluginName);
        await tree.ApplyLoadOrder();

        // The reconcile this load order recorded comes after its re-arm, so the folder's watch is
        // already disposed here and these writes reach no watch at all.
        tree.WriteFile(PluginPath(tree), "changed-after-the-load-order-dropped-it"u8.ToArray());
        tree.WriteFile(Path.Combine(droppedFolder, "texture.dds"), "a tracked file changed too"u8.ToArray());
        tree.AdvancePastBothWindows();

        Assert.Empty(tree.Notifications.Published);
        Assert.Null(SourceRepository.UnansweredExternalChange(droppedFolder));
        Assert.Empty(tree.Index.BinaryPokes);
    }
}
