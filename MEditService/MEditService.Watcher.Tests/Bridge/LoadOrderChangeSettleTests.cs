using MEditService.TestSupport;
using MEditService.Watcher.Tests.TestSupport;

namespace MEditService.Watcher.Tests.Bridge;

/// <summary>The load-time settle, through the verb the live watcher sends: each settle of a tracked
/// mod tells which of its plugins changed outside Modbench.</summary>
public sealed class LoadOrderChangeSettleTests
{
    private const string Origin = "TrackedMod";
    private const string PluginName = "Tracked.esp";
    private const string ExternalChange = "external-change";

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

    private static IReadOnlyList<PublishedNotification> Notices(WatchedTree tree) =>
        [.. tree.Notifications.Published.Where(n => n.Kind == ExternalChange)];

    [Fact]
    public async Task ABinaryThatChangedWithNoWatcherEverRunning_IsNamedAtTheNextLoad_WithTheOriginTheSnapshotNames()
    {
        var (tree, _) = TrackedBeforeWatching();
        using var __ = tree;
        // "Closed" means no FileSystemWatcher instance ever sees this write happen.
        File.WriteAllBytes(PluginPath(tree), "changed-by-xedit"u8.ToArray());

        await tree.ApplyLoadOrder();

        var notice = Assert.Single(Notices(tree));
        Assert.Equal(Origin, notice.Origin);
        Assert.Equal([PluginName], notice.ChangedPlugins);
    }

    // A second window closing after the first is the delivery oracle for "never a second".
    [Fact]
    public async Task ALiveSettle_NamesTheChangedPluginOnce_WithTheOriginTheSnapshotNames()
    {
        var (tree, _) = TrackedBeforeWatching();
        using var __ = tree;
        await tree.ApplyLoadOrder();
        Assert.Empty(Assert.Single(Notices(tree)).ChangedPlugins);

        await tree.Observes(() => tree.WriteFile(PluginPath(tree), "changed-by-xedit"u8.ToArray()));
        tree.AdvancePastBothWindows();
        tree.AdvancePastBothWindows();

        var notices = Notices(tree);
        Assert.Equal(2, notices.Count);
        Assert.Equal(Origin, notices[1].Origin);
        Assert.Equal([PluginName], notices[1].ChangedPlugins);
    }

    // ADR-0015 invariant 2: a restart's compare and a live change's compare are the same call in
    // Commands, so the two tell the same.
    [Fact]
    public async Task ARestartAndALiveChange_TellTheSame()
    {
        var (restarted, _) = TrackedBeforeWatching();
        using var __ = restarted;
        File.WriteAllBytes(PluginPath(restarted), "changed-by-xedit"u8.ToArray());
        await restarted.ApplyLoadOrder();
        var fromRestart = Assert.Single(Notices(restarted));

        var (live, _) = TrackedBeforeWatching();
        using var ___ = live;
        await live.ApplyLoadOrder();
        await live.Observes(() => live.WriteFile(PluginPath(live), "changed-by-xedit"u8.ToArray()));
        live.AdvancePastBothWindows();
        var fromLiveChange = Notices(live)[^1];

        Assert.Equal(fromRestart.Origin, fromLiveChange.Origin);
        Assert.Equal(fromRestart.ChangedPlugins, fromLiveChange.ChangedPlugins);
    }

    [Fact]
    public async Task ALoad_NamesNoPlugin_WhenTheBinaryNeverChanged()
    {
        var (tree, _) = TrackedBeforeWatching();
        using var __ = tree;

        await tree.ApplyLoadOrder();

        Assert.Empty(Assert.Single(tree.Notifications.Published).ChangedPlugins);
    }

    // plugins.md, A row: bytes that cannot be read differ from what Modbench last wrote.
    [Fact]
    public async Task ALoad_NamesATrackedPluginWhoseBinaryIsMissing()
    {
        var (tree, _) = TrackedBeforeWatching();
        using var __ = tree;
        File.Delete(PluginPath(tree));

        await tree.ApplyLoadOrder();

        Assert.Equal([PluginName], Assert.Single(Notices(tree)).ChangedPlugins);
    }

    [Fact]
    public async Task ALoad_LeavesAnUntrackedPluginsMissingBinaryToTheReconcile_AndNeverReadsItForTheSettle()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod("Untracked", PluginName);
        File.Delete(WatchedTree.PluginPath(modFolder, PluginName));

        await tree.ApplyLoadOrder();

        Assert.Single(tree.Index.Reconciles);
        Assert.Empty(tree.LogEntries);
        Assert.Empty(tree.Notifications.Published);
    }

    [Fact]
    public async Task ALoad_ArmsALiveWatch_SoFurtherChangesAreCaughtWithoutAnotherLoad()
    {
        var (tree, _) = TrackedBeforeWatching();
        using var __ = tree;
        await tree.ApplyLoadOrder();

        await tree.Observes(() => tree.WriteFile(PluginPath(tree), "changed-live-after-load"u8.ToArray()));

        tree.AdvancePastBothWindows();

        Assert.Equal([PluginName], Notices(tree)[^1].ChangedPlugins);
        Assert.Single(tree.Index.Reconciles);
    }

    // plugins.md, A row: "changed outside Modbench" needs the plugin tracked, so the status the last
    // settle set goes with the repository.
    [Fact]
    public async Task ATrackedModWhoseRepositoryGoes_NamesNoPluginOnceItSettles()
    {
        var (tree, modFolder) = TrackedBeforeWatching();
        using var _ = tree;
        File.WriteAllBytes(PluginPath(tree), "changed-by-xedit"u8.ToArray());
        await tree.ApplyLoadOrder();
        Assert.Equal([PluginName], Assert.Single(Notices(tree)).ChangedPlugins);

        await tree.RemoveRepository(modFolder);

        Assert.True(await tree.Settles(() => Notices(tree).Count == 2), "the mod never settled once its repository went");
        Assert.Equal(Origin, Notices(tree)[1].Origin);
        Assert.Empty(Notices(tree)[1].ChangedPlugins);
    }

    [Fact]
    public async Task AnUntrackedModThatGainsARepository_IsSettledAsTracked()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, PluginName);
        await tree.ApplyLoadOrder();
        Assert.Empty(Notices(tree));

        tree.MoveInRepository(modFolder, PluginName);

        Assert.True(await tree.Settles(() => Notices(tree).Count == 1), "the mod never settled once it was tracked");
        Assert.Equal(Origin, Notices(tree)[0].Origin);
    }

    // The rival this pins: a repository moved in whole, under a watch already recursive, is one path
    // inside the git directory's own early return.
    [Fact]
    public async Task AModWhoseRepositoryReturns_IsSettledAsTrackedAgain()
    {
        var (tree, modFolder) = TrackedBeforeWatching();
        using var _ = tree;
        await tree.ApplyLoadOrder();
        await tree.RemoveRepository(modFolder);
        Assert.True(await tree.Settles(() => Notices(tree).Count == 2), "the mod never settled once its repository went");

        tree.MoveInRepository(modFolder, PluginName);

        Assert.True(await tree.Settles(() => Notices(tree).Count == 3), "the mod never settled once its repository returned");
    }

    // A load order that arrives before the mod's own window closes answers for the mod at load.
    [Fact]
    public async Task ALoadAfterTheRepositoryWent_NamesNoPlugin_BeforeTheModsOwnWindowCloses()
    {
        var (tree, modFolder) = TrackedBeforeWatching();
        using var _ = tree;
        File.WriteAllBytes(PluginPath(tree), "changed-by-xedit"u8.ToArray());
        await tree.ApplyLoadOrder();

        await tree.RemoveRepository(modFolder);
        tree.AddMod("OtherMod", "Other.esp");
        await tree.ApplyLoadOrder();

        Assert.True(await WatchedTree.Reached(() => Notices(tree).Count == 2), "the load never answered for the mod");
        Assert.Empty(Notices(tree)[1].ChangedPlugins);
    }

    // The rival this pins: a re-arm that forgets the registrations but keeps the folder's watch, so a
    // mod the load order dropped still settles into Commands with no origin to put on it.
    [Fact]
    public async Task ATrackedModDroppedFromTheLoadOrder_TellsNothing_WhenItsFilesChange()
    {
        var (tree, droppedFolder) = TrackedBeforeWatching();
        using var _ = tree;
        var keptFolder = tree.AddMod("KeptMod", "Kept.esp");
        WatchedTree.Track(keptFolder, "Kept.esp");
        await tree.ApplyLoadOrder();

        tree.RemovePlugin(PluginName);
        await tree.ApplyLoadOrder();
        var toldBefore = tree.Notifications.Published.Count;

        // The reconcile this load order recorded comes after its re-arm, so the folder's watch is
        // already disposed here and these writes reach no watch at all.
        tree.WriteFile(PluginPath(tree), "changed-after-the-load-order-dropped-it"u8.ToArray());
        tree.WriteFile(Path.Combine(droppedFolder, "texture.dds"), "a tracked file changed too"u8.ToArray());
        tree.AdvancePastBothWindows();

        Assert.Equal(toldBefore, tree.Notifications.Published.Count);
        Assert.Empty(tree.Index.BinaryPokes);
    }
}
