using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Bridge;

/// <summary>ADR-0009: every indexed binary the load order holds, tracked or not, is watched. The
/// Index owns the comparison, so what the watcher does is poke it with the key and the path.</summary>
public sealed class IndexedBinaryWatchTests
{
    private const string Origin = "Untracked";
    private const string PluginName = "Mirrored.esp";
    private static readonly PluginCopyKey Copy = new(PluginName, Origin);

    // Untracked, so Rearm takes the indexed-binary route for it, and seeded as a prior reconcile
    // would have left it: already indexed at the bytes on disk now.
    private static (WatchedTree Tree, string PluginPath) Watching(bool seeded = true)
    {
        var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, PluginName, "original"u8.ToArray());
        var pluginPath = WatchedTree.PluginPath(modFolder, PluginName);
        if (seeded) tree.Index.SeedIndexed(Copy, WatchedTree.ContentHashOf(pluginPath));
        tree.ApplyLoadOrder();
        tree.Watcher.Rearm(tree.Holder.Current);
        return (tree, pluginPath);
    }

    [Fact]
    public async Task AnIndexedBinaryWhoseBytesChange_IsReindexed()
    {
        var (tree, pluginPath) = Watching();
        using var _ = tree;

        File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());

        Assert.True(await tree.Settles(() => tree.Index.Of("reindex").Count > 0));
        Assert.Equal(Copy, Assert.Single(tree.Index.Of("reindex")).Plugin);
        Assert.Empty(tree.Index.Of("unindex"));
    }

    // Content, never events: a rewrite landing identical bytes — a touch, a re-link, a re-extract
    // of the same archive — costs no re-index at all.
    [Fact]
    public async Task AnIndexedBinaryRewrittenWithIdenticalBytes_ReachesTheIndexNotAtAll()
    {
        var (tree, pluginPath) = Watching();
        using var _ = tree;

        File.WriteAllBytes(pluginPath, "original"u8.ToArray());

        Assert.True(await tree.NothingReaches(() => tree.Index.Projections.Count > 0));
    }

    // A deletion is its own verb: the Index must forget the copy, not re-read a file that is gone.
    [Fact]
    public async Task AnIndexedBinaryThatIsDeleted_IsUnindexed()
    {
        var (tree, pluginPath) = Watching();
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
        var (tree, pluginPath) = Watching();
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
        var (tree, pluginPath) = Watching(seeded: false);
        using var _ = tree;

        File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());

        Assert.True(await tree.Settles(() => tree.Index.Of("reindex").Count > 0));
        Assert.Equal(Copy, Assert.Single(tree.Index.Of("reindex")).Plugin);
    }

    // ADR-0014: "whenever the plugin watcher re-indexes a binary" is exactly the trigger this
    // notification names, and it carries the copy so a client knows what to re-read.
    [Fact]
    public async Task AnIndexedBinaryWhoseBytesChange_PublishesPluginChanged()
    {
        var (tree, pluginPath) = Watching();
        using var _ = tree;

        File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());

        Assert.True(await tree.Settles(() => tree.Notifications.Notifications.Count > 0));
        var changed = Assert.IsType<PluginChangedNotification>(Assert.Single(tree.Notifications.Notifications));
        Assert.Equal(Copy, changed.Plugin);
    }

    // The remembered hash must go back on a refusal, or the watcher believes bytes it never landed
    // are indexed and the stale rows stand silently until the next load.
    [Fact]
    public async Task AChangeTheIndexCouldNotTake_IsProjectedAgainOnTheNextSettle()
    {
        var (tree, pluginPath) = Watching();
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
        tree.ApplyLoadOrder();
        tree.Watcher.Rearm(tree.Holder.Current);

        File.WriteAllBytes(WatchedTree.PluginPath(modFolder, "Tracked.esp"), "changed-by-xedit"u8.ToArray());

        Assert.True(await tree.NothingReaches(() => tree.Index.Of("reindex").Count > 0));
    }
}
