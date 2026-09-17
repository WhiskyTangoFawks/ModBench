using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Watcher.Tests.TestSupport;

namespace MEditService.Watcher.Tests.Bridge;

/// <summary>ADR-0009: every indexed binary the load order holds, tracked or not, is watched. The
/// Index owns the comparison and the announcement, so what the watcher does is poke it with the
/// key and the path.</summary>
public sealed class IndexedBinaryWatchTests
{
    private const string Origin = "Untracked";
    private const string PluginName = "Mirrored.esp";
    private static readonly PluginCopyKey Copy = new(PluginName, Origin);

    // Untracked, so the load order arms the indexed-binary route for it, and seeded as a prior
    // reconcile would have left it: already indexed at the bytes on disk now.
    private static async Task<(WatchedTree Tree, string PluginPath)> Watching(bool seeded = true)
    {
        var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, PluginName, "original"u8.ToArray());
        var pluginPath = WatchedTree.PluginPath(modFolder, PluginName);
        if (seeded) tree.Index.SeedIndexed(Copy, WatchedTree.ContentHashOf(pluginPath));
        await tree.ApplyLoadOrder();
        return (tree, pluginPath);
    }

    [Fact]
    public async Task AnIndexedBinaryWhoseBytesChange_IsReindexed()
    {
        var (tree, pluginPath) = await Watching();
        using var _ = tree;

        File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());

        Assert.True(await tree.Settles(() => tree.Index.Of("reindex").Count > 0));
        Assert.Equal(Copy, Assert.Single(tree.Index.Of("reindex")).Plugin);
        Assert.Empty(tree.Index.Of("unindex"));
    }

    // Content, never events: the watcher pokes with the key and the path, and Commands hears
    // nothing of an untracked mod, so identical bytes raise nothing anywhere.
    [Fact]
    public async Task AnIndexedBinaryRewrittenWithIdenticalBytes_IsPokedAndNothingElse()
    {
        var (tree, pluginPath) = await Watching();
        using var _ = tree;

        File.WriteAllBytes(pluginPath, "original"u8.ToArray());

        Assert.True(await tree.Settles(() => tree.Index.BinaryPokes.Count > 0));
        Assert.Equal((Copy, pluginPath), Assert.Single(tree.Index.BinaryPokes));
        Assert.Empty(tree.Notifications.Published);
    }

    // A deletion is its own verb: the Index must forget the copy, not re-read a file that is gone.
    [Fact]
    public async Task AnIndexedBinaryThatIsDeleted_IsUnindexed()
    {
        var (tree, pluginPath) = await Watching();
        using var _ = tree;

        File.Delete(pluginPath);

        Assert.True(await tree.Settles(() => tree.Index.Of("unindex").Count > 0));
        Assert.Equal(Copy, Assert.Single(tree.Index.Of("unindex")).Plugin);
        Assert.Empty(tree.Index.Of("reindex"));
    }

    // A reinstall or a file verify puts the copy back, and the watch follows the disk both ways.
    [Fact]
    public async Task AnIndexedBinaryThatComesBack_IsReindexed()
    {
        var (tree, pluginPath) = await Watching();
        using var _ = tree;

        File.Delete(pluginPath);
        Assert.True(await tree.Settles(() => tree.Index.Of("unindex").Count > 0));

        File.WriteAllBytes(pluginPath, "reinstalled"u8.ToArray());

        Assert.True(await tree.Settles(() => tree.Index.Of("reindex").Count > 0));
        Assert.Equal(["unindex", "reindex"], tree.Index.Projections.Select(p => p.Verb));
    }

    // ADR-0003: a copy the Index has never indexed is armed all the same, so its first change
    // reaches the Index with no reconcile in between.
    [Fact]
    public async Task ACopyTheIndexHasNeverIndexed_IsArmedAnyway()
    {
        var (tree, pluginPath) = await Watching(seeded: false);
        using var _ = tree;

        File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());

        Assert.True(await tree.Settles(() => tree.Index.Of("reindex").Count > 0));
        Assert.Equal(Copy, Assert.Single(tree.Index.Of("reindex")).Plugin);
    }

    // A watch must not outlive the load order that asked for it, or a copy the load order has
    // dropped would keep re-indexing itself into the Index.
    [Fact]
    public async Task ACopyTheLoadOrderHasDropped_StopsReachingTheIndex()
    {
        var (tree, pluginPath) = await Watching();
        using var _ = tree;
        var modFolder = Path.GetDirectoryName(pluginPath)
            ?? throw new InvalidOperationException("the plugin has no folder");
        using var oracle = WatchedTree.ArmOracleIn(modFolder);

        tree.RemoveCopy(PluginName);
        await tree.ApplyLoadOrder();

        File.WriteAllBytes(pluginPath, "changed-after-the-load-order-dropped-it"u8.ToArray());
        Assert.True(await oracle.Delivered(), "the rewrite never reached a watch on the mod folder");
        tree.AdvancePastBothWindows();

        Assert.Empty(tree.Index.BinaryPokes);
        Assert.Empty(tree.Index.Projections);
    }

    [Fact]
    public async Task AChangeTheIndexCouldNotTake_IsProjectedAgainOnTheNextSettle()
    {
        var (tree, pluginPath) = await Watching();
        using var _ = tree;
        tree.Index.Refuses = true;

        File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());
        Assert.True(await tree.Settles(() => tree.Index.Of("reindex").Count > 0));

        // The same bytes settle again. Had the refused projection advanced the remembered hash,
        // this would raise nothing and the Index would stay stale.
        File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());

        Assert.True(await tree.Settles(() => tree.Index.Of("reindex").Count > 1));
        Assert.All(tree.Index.Of("reindex"), r => Assert.Equal(Copy, r.Plugin));
    }

    // A tracked copy's rows come from its source tree, so re-reading the binary would overwrite the
    // working tree with the compiled artifact: it is a question for the user, never a re-index.
    [Fact]
    public async Task ATrackedPluginWhoseBinaryChanges_IsNeverSilentlyReindexed()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod("Tracked", "Tracked.esp");
        WatchedTree.Track(modFolder, "Tracked.esp");
        await tree.ApplyLoadOrder();

        using var oracle = WatchedTree.ArmOracleIn(modFolder);
        File.WriteAllBytes(WatchedTree.PluginPath(modFolder, "Tracked.esp"), "changed-by-xedit"u8.ToArray());
        Assert.True(await oracle.Delivered(), "the rewrite never reached a watch on the mod folder");

        tree.AdvancePastBothWindows();

        Assert.Empty(tree.Index.BinaryPokes);
        Assert.Empty(tree.Index.Of("reindex"));
        Assert.NotNull(SourceRepository.UnansweredExternalChange(modFolder));
    }
}
