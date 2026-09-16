using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Bridge;

/// <summary>ADR-0015 invariant 4: an OS overflow dropped events, so the watcher compares the copy by
/// content hash instead of trusting what it saw.</summary>
public sealed class WatchOverflowTests : IDisposable
{
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly IndexedModFixture _mod;

    public WatchOverflowTests() => _mod = IndexedModFixture.Tracked(_notifications);

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void ValidateAfterOverflow_ReDerivesTheDriftedRow_AndPublishesItsCorrection()
    {
        var text = File.ReadAllText(_mod.NpcSourceFile);
        File.WriteAllText(
            _mod.NpcSourceFile, text.Replace("\"FixtureNpc\"", "\"EditedWhileRunning\"", StringComparison.Ordinal));
        using var watcher = TestWatcher.Over(_mod.Holder, _mod.Index, _notifications);

        watcher.ValidateAfterOverflow(_mod.Plugin);

        var store = _mod.Index.RequireReads();
        var document = store.GetDocument(_mod.Npc.ToString(), _mod.Plugin);
        Assert.NotNull(document);
        Assert.Equal("EditedWhileRunning", document.EditorId);
        // A single edited field drifts one row, not the whole document set — Validate's own
        // RowsChangedNotification, not the re-derived-whole branch.
        Assert.Contains(_notifications.Notifications, n => n is RowsChangedNotification rc && rc.Plugin == _mod.Plugin);
    }

    // Both routes on one copy is one dropped-events verdict, not two. The origin comes off the watch
    // that was armed, because a load order holding no such copy can answer nothing.
    [Fact]
    public void AnOverflow_OnACopyArmedBothWays_ValidatesItOnce_WithTheOriginItsWatchKnows()
    {
        var index = new RecordingRefreshIndex();
        var pluginPath = Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName);
        using var watcher = TestWatcher.Over(new LoadOrderHolder(), index, _notifications);
        watcher.Watch(_mod.ModFolder, IndexedModFixture.PluginName, pluginPath);
        watcher.WatchIndexed(IndexedModFixture.PluginName, IndexedModFixture.ModFolderOrigin, pluginPath);

        watcher.Interrupted(_mod.ModFolder);

        var validated = Assert.Single(index.Of("validate"));
        Assert.Equal(
            new PluginCopyKey(IndexedModFixture.PluginName, IndexedModFixture.ModFolderOrigin), validated.Plugin);
    }

    [Fact]
    public void ValidateAfterOverflow_PublishesNothing_WhenTheTrackedSourceHasNotDrifted()
    {
        using var watcher = TestWatcher.Over(_mod.Holder, _mod.Index, _notifications);

        watcher.ValidateAfterOverflow(_mod.Plugin);

        Assert.Empty(_notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Empty(_notifications.Notifications.OfType<PluginChangedNotification>());
    }
}
