using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Bridge;

/// <summary>Disposal races the settle it interrupts: the timers fire on the pool with no caller to
/// catch anything, so a batch still open when the watcher goes must simply stop.</summary>
public sealed class WatcherDisposalTests
{
    private const string Origin = "OneMod";
    private const string PluginName = "A.esp";

    [Fact]
    public async Task DisposingTheWatcher_StopsAnOpenBatchFromEverSettling()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, PluginName);
        WatchedTree.Track(modFolder, PluginName);
        tree.ApplyLoadOrder();
        tree.Watcher.WatchSourceOf(Origin);
        using var oracle = tree.ArmOracleIn(modFolder);

        WatchedTree.WriteUnnamedDocument(modFolder, PluginName);
        // The oracle settles a batch of its own only once the write has reached an inotify watch on
        // this folder, which is when the subject's batch is open too.
        Assert.True(await oracle.Delivered(), "the write never reached a watch on the mod folder");

        tree.Watcher.Dispose();
        var thrown = Record.Exception(tree.AdvancePastBothWindows);

        Assert.Null(thrown);
        Assert.Empty(tree.Index.Projections);
        Assert.Empty(tree.LogEntries);
    }
}
