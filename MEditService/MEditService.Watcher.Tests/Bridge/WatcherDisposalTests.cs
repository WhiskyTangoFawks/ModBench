using MEditService.Watcher.Tests.TestSupport;

namespace MEditService.Watcher.Tests.Bridge;

/// <summary>Disposal races the settle it interrupts: the timers fire with no caller to catch
/// anything, so a batch still open when the watcher goes must simply stop, and a sink already
/// running must finish before Dispose returns.</summary>
public sealed class WatcherDisposalTests
{
    private const string Origin = "OneMod";
    private const string PluginName = "A.esp";

    private static async Task<(WatchedTree Tree, string ModFolder)> WatchingATrackedMod()
    {
        var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, PluginName);
        WatchedTree.Track(modFolder, PluginName);
        await tree.ApplyLoadOrder();
        return (tree, modFolder);
    }

    [Fact]
    public async Task DisposingTheWatcher_StopsAnOpenBatchFromEverSettling()
    {
        var (tree, modFolder) = await WatchingATrackedMod();
        using var _ = tree;
        await tree.Observes(() => tree.WriteUnnamedDocument(modFolder, PluginName));

        tree.Watcher.Dispose();
        var thrown = Record.Exception(tree.AdvancePastBothWindows);

        Assert.Null(thrown);
        Assert.Empty(tree.Index.Projections);
        Assert.Empty(tree.LogEntries);
    }

    // The rival this pins: a Dispose that stops the timers and returns while a settle is still
    // inside the Index, which leaves a git process writing into a folder the caller then deletes.
    [Fact]
    public async Task DisposingTheWatcher_ReturnsOnlyAfterASinkAlreadyRunningHasFinished()
    {
        var (tree, modFolder) = await WatchingATrackedMod();
        using var _ = tree;
        using var release = new ManualResetEventSlim();
        tree.Index.HoldsValidateUntil = release;
        var order = new List<string>();

        await tree.Observes(() => tree.WriteUnnamedDocument(modFolder, PluginName));
        var settle = Task.Run(tree.AdvancePastBothWindows);
        Assert.True(await WatchedTree.Reached(() => tree.Index.Of("projection").Count > 0), "the settle never reached the Index");

        var disposing = Task.Run(() =>
        {
            lock (order) order.Add("dispose called");
            tree.Watcher.Dispose();
            lock (order) order.Add("disposed");
        });
        Assert.True(await WatchedTree.Reached(() => { lock (order) return order.Count > 0; }));
        lock (order) order.Add("sink released");
        release.Set();
        await settle;
        await disposing;

        Assert.Equal(["dispose called", "sink released", "disposed"], order);
        Assert.Single(tree.Index.Of("validate"));
    }
}
