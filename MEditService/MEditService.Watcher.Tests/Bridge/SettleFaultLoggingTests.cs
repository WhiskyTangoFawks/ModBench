using MEditService.Index;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;

namespace MEditService.Tests.Bridge;

/// <summary>ADR-0019: the timer callback that raises a settled batch has no caller to propagate to,
/// so a fault must reach the injected logger rather than vanishing.</summary>
public sealed class SettleFaultLoggingTests
{
    private const string Origin = "OneMod";
    private const string PluginName = "A.esp";

    private static WatchedTree Watching()
    {
        var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, PluginName);
        WatchedTree.Track(modFolder, PluginName);
        tree.ApplyLoadOrder();
        tree.Watcher.WatchSourceOf(Origin);
        return tree;
    }

    private static string ModFolderOf(WatchedTree tree) => Path.Combine(tree.InstanceRoot, "mods", Origin);

    [Fact]
    public async Task ASettledBatch_IsLoggedRatherThanLost_WhenAnotherWriterHoldsTheGate()
    {
        using var tree = Watching();
        tree.Index.WriteGate = new IndexWriteGate(TimeSpan.FromMilliseconds(100));

        using var held = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var otherWriter = Task.Run(() =>
        {
            using var _ = tree.Index.WriteGate.Enter();
            held.Set();
            release.Wait(TimeSpan.FromSeconds(10));
        });
        Assert.True(held.Wait(TimeSpan.FromSeconds(5)), "the holder never took the gate");

        WatchedTree.WriteUnnamedDocument(ModFolderOf(tree), PluginName);
        var logged = await tree.Settles(() => tree.LogEntries.Count > 0);

        release.Set();
        await otherWriter.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.True(logged, "the refused batch was never logged");
        Assert.Contains(tree.LogEntries, e => e.Level == LogLevel.Warning
            && e.Message.Contains(PluginName, StringComparison.Ordinal)
            && e.Message.Contains("re-checked", StringComparison.Ordinal));
        // The gate refused before the first plugin was projected, so nothing reached the Index.
        Assert.Empty(tree.Index.Of("validate"));
    }

    // Anything the batch cannot recover from itself: no caller is left to catch it, so the last
    // resort is the log.
    [Fact]
    public async Task ASettleThatFaultsOutright_IsLoggedRatherThanLost()
    {
        using var tree = Watching();
        tree.Index.RefusesProjectionScope = true;

        WatchedTree.WriteUnnamedDocument(ModFolderOf(tree), PluginName);

        Assert.True(await tree.Settles(() => tree.LogEntries.Count > 0));
        Assert.Contains(tree.LogEntries, e => e.Level == LogLevel.Error
            && e.Message.Contains("failed unexpectedly", StringComparison.Ordinal)
            && e.Exception?.Message == "the store could not open a scope");
    }
}
