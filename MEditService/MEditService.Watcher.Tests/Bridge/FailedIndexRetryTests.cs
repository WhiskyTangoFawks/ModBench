using MEditService.Watcher.Tests.TestSupport;

namespace MEditService.Watcher.Tests.Bridge;

/// <summary>plugins.md, States, story 6: the next change to the instance tries a failed index
/// again. Every settled window asks the Index once; whether the last reconcile failed is the
/// Index's answer.</summary>
public sealed class FailedIndexRetryTests
{
    private const string PluginName = "A.esp";

    private static async Task<(WatchedTree Tree, string ModFolder)> Watching(bool tracked)
    {
        var tree = new WatchedTree();
        var modFolder = tree.AddMod("Mod", PluginName);
        if (tracked) WatchedTree.Track(modFolder, PluginName);
        await tree.ApplyLoadOrder();
        return (tree, modFolder);
    }

    [Fact]
    public async Task ATrackedBinaryChange_AsksForTheRetryOnce()
    {
        var (tree, modFolder) = await Watching(tracked: true);
        using var _ = tree;
        var told = tree.Notifications.Published.Count;

        await tree.Observes(() => tree.WriteFile(WatchedTree.PluginPath(modFolder, PluginName), "changed"u8.ToArray()));

        Assert.True(await tree.Settles(() => tree.Notifications.Published.Count > told), "the tracked mod never settled");
        Assert.Equal(1, tree.Index.Retries);
    }

    [Fact]
    public async Task ASourceChange_AsksForTheRetryOnce()
    {
        var (tree, modFolder) = await Watching(tracked: true);
        using var _ = tree;

        await tree.Observes(() => tree.WriteRecord(modFolder, PluginName, "000800:A.esp"));

        Assert.True(await tree.Settles(() => tree.Index.Of("refresh").Count > 0), "the source change never settled");
        Assert.Equal(1, tree.Index.Retries);
    }

    [Fact]
    public async Task AnUntrackedBinaryChange_AsksForTheRetryOnce()
    {
        var (tree, modFolder) = await Watching(tracked: false);
        using var _ = tree;

        await tree.Observes(() => tree.WriteFile(WatchedTree.PluginPath(modFolder, PluginName), "changed"u8.ToArray()));

        Assert.True(await tree.Settles(() => tree.Index.BinaryPokes.Count > 0), "the binary never settled");
        Assert.Equal(1, tree.Index.Retries);
    }

    [Fact]
    public async Task AWindowOfSeveralChanges_AsksForTheRetryOnce()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod("Mod", PluginName);
        tree.AddPlugin("Mod", modFolder, "B.esp");
        await tree.ApplyLoadOrder();

        await tree.Observes(
            () => tree.WriteFile(WatchedTree.PluginPath(modFolder, PluginName), "changed"u8.ToArray()),
            () => tree.WriteFile(WatchedTree.PluginPath(modFolder, "B.esp"), "changed"u8.ToArray()));

        Assert.True(await tree.Settles(() => tree.Index.BinaryPokes.Count == 2), "the window never settled");
        Assert.Equal(1, tree.Index.Retries);
    }
}
