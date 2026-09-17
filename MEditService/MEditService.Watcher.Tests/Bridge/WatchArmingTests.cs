using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Bridge;

/// <summary>ADR-0014 invariant 3 and ADR-0015: which folders a load order puts under watch, and
/// the registration Track makes before it writes a byte.</summary>
public sealed class WatchArmingTests
{
    private const string Origin = "TrackedMod";
    private const string PluginName = "Tracked.esp";

    // The rival this pins: a SubscribeTo that never wires Changed, leaving every plugin unwatched
    // when a load order arrives through Apply.
    [Fact]
    public async Task SubscribeTo_ArmsTheWatch_WhenTheLoadOrderChanges()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod("Untracked", "Mirrored.esp", "original"u8.ToArray());
        tree.Watcher.SubscribeTo(tree.Holder);

        tree.ApplyLoadOrder();

        // Rearm runs off the caller's thread, so the write is retried until the watch is live.
        Assert.True(await tree.Settles(() =>
        {
            File.WriteAllBytes(WatchedTree.PluginPath(modFolder, "Mirrored.esp"), Guid.NewGuid().ToByteArray());
            return tree.Index.Of("reindex").Count > 0;
        }));
        Assert.Equal("Mirrored.esp", (Assert.Single(tree.Index.Of("reindex")).Plugin
            ?? throw new InvalidOperationException("a reindex names no plugin")).Name);
    }

    // The rival this pins: a registration made after Track's commit, which has no ref move left to
    // see, so the tree Track just wrote never reaches the Index.
    [Fact]
    public async Task TrackingAModUnderALiveWatch_ValidatesItWhole_WithNoReconcile()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, PluginName);
        tree.ApplyLoadOrder();
        tree.Watcher.Rearm(tree.Holder.Current);

        // The endpoint's own order: the registration upgrades the watch before Track writes.
        tree.Watcher.WatchSourceOf(Origin);
        WatchedTree.Track(modFolder, PluginName);

        Assert.True(await tree.Settles(() => tree.Index.Of("validate").Count > 0));
        Assert.Equal(PluginName, (tree.Index.Of("validate")[0].Plugin
            ?? throw new InvalidOperationException("a validate names no plugin")).Name);
    }

    // The rival this pins: unregistering the source root on a settle that finds no repository,
    // which takes Track's registration with it while Track is still writing.
    [Fact]
    public async Task ASettleBeforeTheRepositoryExists_KeepsTheRegistration()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, PluginName);
        tree.ApplyLoadOrder();
        tree.Watcher.Rearm(tree.Holder.Current);
        tree.Watcher.WatchSourceOf(Origin);

        // A write under the source root while the mod is still untracked: a batch opens and closes
        // with nothing to project from.
        Directory.CreateDirectory(SourceRepository.RootIn(modFolder, PluginName));
        WatchedTree.WriteUnnamedDocument(modFolder, PluginName);
        Assert.True(await tree.NothingReaches(() => tree.Index.Of("validate").Count > 0));

        WatchedTree.Track(modFolder, PluginName);

        Assert.True(await tree.Settles(() => tree.Index.Of("validate").Count > 0));
        Assert.Equal(PluginName, (tree.Index.Of("validate")[0].Plugin
            ?? throw new InvalidOperationException("a validate names no plugin")).Name);
    }

    // A mod folder the gesture registering it is about to create has nothing to watch yet, so that
    // tree's own burst is lost; the rival this pins is registering once and never again.
    [Fact]
    public async Task AModFolderNotOnDiskYet_ArmsNothing_UntilItIsRegisteredAgain()
    {
        using var tree = new WatchedTree();
        var modFolder = tree.AddMod(Origin, PluginName);
        tree.ApplyLoadOrder();
        Directory.Delete(modFolder, recursive: true);

        tree.Watcher.WatchSourceOf(Origin);

        Directory.CreateDirectory(modFolder);
        WatchedTree.Track(modFolder, PluginName);
        Assert.True(await tree.NothingReaches(() => tree.Index.Projections.Count > 0));

        tree.Watcher.WatchSourceOf(Origin);
        WatchedTree.WriteUnnamedDocument(modFolder, PluginName);

        Assert.True(await tree.Settles(() => tree.Index.Of("validate").Count > 0));
        Assert.Equal(PluginName, (tree.Index.Of("validate")[0].Plugin
            ?? throw new InvalidOperationException("a validate names no plugin")).Name);
    }
}
