using MEditService.Core.Notifications;
using MEditService.Core.Records;
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

        Assert.Equal(
            "EditedWhileRunning",
            _mod.Index.Store!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.EditorId);
        // A single edited field drifts one row, not the whole document set — Validate's own
        // RowsChangedNotification, not the re-derived-whole branch.
        Assert.Contains(_notifications.Notifications, n => n is RowsChangedNotification rc && rc.Plugin == _mod.Plugin);
    }

    [Fact]
    public void ValidateAfterOverflow_PublishesNothing_WhenTheTrackedSourceHasNotDrifted()
    {
        using var watcher = TestWatcher.Over(_mod.Holder, _mod.Index, _notifications);

        watcher.ValidateAfterOverflow(_mod.Plugin);

        Assert.Empty(_notifications.Notifications);
    }
}
