using MEditService.SourceAdapter;
using MEditService.Watcher.Tests.TestSupport;

namespace MEditService.Watcher.Tests.Bridge;

/// <summary>The Mod watcher's arming: which folders a load order puts under watch, and the
/// upgrade a watch makes for itself when a source tree or a repository appears under an untracked
/// mod.</summary>
public sealed class WatchArmingTests
{
    private const string Origin = "TrackedMod";
    private const string PluginName = "Tracked.esp";

    // The rival this pins: a Subscribe that never wires Changed, leaving every plugin unwatched
    // when a load order arrives through Apply.
    [Fact]
    public async Task Subscribe_ArmsTheWatch_WhenTheLoadOrderChanges()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod("Untracked", "Mirrored.esp", "original"u8.ToArray());

        await tree.ApplyLoadOrder();

        await tree.Observes(() =>
            tree.WriteFile(WatchedTree.PluginPath(modFolder, "Mirrored.esp"), "changed-by-xedit"u8.ToArray()));

        tree.AdvancePastBothWindows();

        Assert.Equal("Mirrored.esp", (Assert.Single(tree.Index.Of("reindex")).Plugin
            ?? throw new InvalidOperationException("a reindex names no plugin")).Name);
    }

    // The rival this pins: a subscription that reconciles but never arms, or arms without
    // reconciling — each change is exactly one of each.
    [Fact]
    public async Task ALoadOrderChange_ReconcilesTheIndexExactlyOnce_WithTheVersionTheHolderNamed()
    {
        using var tree = new WatchedTree();
        tree.AddMod("Untracked", "Mirrored.esp");

        var version = tree.Holder.Apply(tree.Snapshot());
        Assert.True(await WatchedTree.Reached(() => tree.Index.Reconciles.Count > 0));

        var reconcile = Assert.Single(tree.Index.Reconciles);
        Assert.Equal(version, reconcile.Version);
        Assert.Same(tree.Holder.Current, reconcile.Snapshot);
    }

    // The rival this pins: a top-level watch that stays top-level, so the tree Track writes under
    // an untracked mod never reaches the Index until the next load-order change.
    [Fact]
    public async Task TrackingAModUnderALiveWatch_ValidatesItWhole_WithNoReconcile()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, PluginName);
        await tree.ApplyLoadOrder();

        WatchedTree.Track(modFolder, PluginName);

        Assert.True(await tree.Settles(() => tree.Index.Of("validate").Count > 0));
        Assert.Equal(PluginName, (tree.Index.Of("validate")[0].Plugin
            ?? throw new InvalidOperationException("a validate names no plugin")).Name);
        Assert.Single(tree.Index.Reconciles);
    }

    // The upgrade is what lets a document written after Track reach the Index by name: the watch
    // that saw the tree appear now sees everything under it.
    [Fact]
    public async Task ADocumentWrittenAfterTheTreeAppeared_ReachesTheIndexByKey()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, PluginName);
        await tree.ApplyLoadOrder();
        await tree.Observes(() => tree.MoveInRepository(modFolder, PluginName));
        await tree.Observes(() => tree.MoveInSourceRoot(modFolder, PluginName));
        Assert.True(await tree.Settles(() => tree.Index.Of("validate").Count > 0));

        tree.WriteRecord(modFolder, PluginName, "000800:Tracked.esp");

        Assert.True(await tree.Settles(() => tree.Index.Of("refresh").Count > 0));
        Assert.Equal(["000800:Tracked.esp"], Assert.Single(tree.Index.Of("refresh")).Keys);
    }

    // ADR-0003: another tool removed the repository, the roots outlived it, and a re-Track writes
    // the repository alone. The rival this pins: an upgrade that rides only on a root appearing.
    [Fact]
    public async Task ReTrackingAModWhoseRootsOutlivedTheRepository_ReachesTheIndexByKey()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, PluginName);
        Directory.CreateDirectory(SourceRepository.RootIn(modFolder, PluginName));
        await tree.ApplyLoadOrder();

        await tree.Observes(() => tree.MoveInRepository(modFolder, PluginName));
        Assert.True(await tree.Settles(() => tree.Index.Of("validate").Count > 0));

        tree.WriteRecord(modFolder, PluginName, "000800:Tracked.esp");

        Assert.True(await tree.Settles(() => tree.Index.Of("refresh").Count > 0));
        Assert.Equal(["000800:Tracked.esp"], Assert.Single(tree.Index.Of("refresh")).Keys);
    }

    // The rival this pins: unregistering the source root on a settle that finds no repository.
    // The root here appears before the repository, the reverse of Track's own order.
    [Fact]
    public async Task ASettleBeforeTheRepositoryExists_KeepsTheRegistration()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, PluginName);
        await tree.ApplyLoadOrder();

        // The source root appearing while the mod is still untracked: a batch opens and closes with
        // nothing to project from.
        await tree.Observes(() => tree.MoveInSourceRoot(modFolder, PluginName));
        tree.AdvancePastBothWindows();
        Assert.Empty(tree.Index.Of("validate"));

        WatchedTree.Track(modFolder, PluginName);

        Assert.True(await tree.Settles(() => tree.Index.Of("validate").Count > 0));
        Assert.Equal(PluginName, (tree.Index.Of("validate")[0].Plugin
            ?? throw new InvalidOperationException("a validate names no plugin")).Name);
    }

    // A mod folder not on disk when the load order names it has nothing to watch, so that
    // folder's later burst is lost; the next load-order change is what arms it.
    [Fact]
    public async Task AModFolderNotOnDiskAtLoad_ArmsNothing_UntilTheNextLoadOrderChange()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, PluginName);
        Directory.Delete(modFolder, recursive: true);
        await tree.ApplyLoadOrder();

        // The arming this load order did came before the folder existed, so nothing Track writes
        // here has a watch to reach.
        Directory.CreateDirectory(modFolder);
        WatchedTree.Track(modFolder, PluginName);
        tree.AdvancePastBothWindows();
        Assert.Empty(tree.Index.Projections);

        tree.AddMod("OtherMod", "Other.esp");
        await tree.ApplyLoadOrder();
        await tree.Observes(() => tree.WriteUnnamedDocument(modFolder, PluginName));

        tree.AdvancePastBothWindows();

        Assert.Equal(PluginName, (Assert.Single(tree.Index.Of("validate")).Plugin
            ?? throw new InvalidOperationException("a validate names no plugin")).Name);
    }
}
