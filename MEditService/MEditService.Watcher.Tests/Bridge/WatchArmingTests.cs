using MEditService.SourceRepo;
using MEditService.Watcher.Tests.TestSupport;

namespace MEditService.Watcher.Tests.Bridge;

/// <summary>ADR-0015 invariant 2: which folders a load order puts under watch, and the upgrade a
/// watch makes for itself when a source tree or a repository appears under an untracked mod.</summary>
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

        File.WriteAllBytes(WatchedTree.PluginPath(modFolder, "Mirrored.esp"), "changed-by-xedit"u8.ToArray());
        Assert.True(await tree.Settles(() => tree.Index.Of("reindex").Count > 0));
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
        WatchedTree.Track(modFolder, PluginName);
        Assert.True(await tree.Settles(() => tree.Index.Of("validate").Count > 0));

        WatchedTree.WriteRecord(modFolder, PluginName, "000800:Tracked.esp");

        Assert.True(await tree.Settles(() => tree.Index.Of("refresh").Count > 0));
        Assert.Equal(["000800:Tracked.esp"], Assert.Single(tree.Index.Of("refresh")).Keys);
    }

    // The rival this pins: unregistering the source root on a settle that finds no repository,
    // which takes the registration with it while Track is still writing.
    [Fact]
    public async Task ASettleBeforeTheRepositoryExists_KeepsTheRegistration()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, PluginName);
        await tree.ApplyLoadOrder();

        // A write under the source root while the mod is still untracked: a batch opens and closes
        // with nothing to project from.
        Directory.CreateDirectory(SourceRepository.RootIn(modFolder, PluginName));
        using var oracle = WatchedTree.ArmOracleIn(modFolder);
        WatchedTree.WriteUnnamedDocument(modFolder, PluginName);
        Assert.True(await oracle.Delivered(), "the write never reached a watch on the mod folder");
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

        Directory.CreateDirectory(modFolder);
        WatchedTree.Track(modFolder, PluginName);
        using var oracle = WatchedTree.ArmOracleIn(modFolder);
        Assert.True(await oracle.Delivered(), "the tree never reached a watch on the mod folder");
        tree.AdvancePastBothWindows();
        Assert.Empty(tree.Index.Projections);

        await tree.ApplyLoadOrder();
        WatchedTree.WriteUnnamedDocument(modFolder, PluginName);

        Assert.True(await tree.Settles(() => tree.Index.Of("validate").Count > 0));
        Assert.Equal(PluginName, (tree.Index.Of("validate")[0].Plugin
            ?? throw new InvalidOperationException("a validate names no plugin")).Name);
    }
}
