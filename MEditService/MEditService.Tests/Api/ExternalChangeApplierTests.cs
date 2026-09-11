using MEditService.Api;
using MEditService.Core.Notifications;
using MEditService.Core.Records;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Api;

/// <summary>ADR-0046 invariant 6: the plugin watcher's overflow delegate routes to
/// <c>IndexProjector.ValidateIndex</c>, mirroring <see cref="SourceChangeApplier"/>'s own shape.</summary>
public sealed class ExternalChangeApplierTests : IDisposable
{
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly IndexedModFixture _mod;

    public ExternalChangeApplierTests() => _mod = IndexedModFixture.Tracked(_notifications);

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void ApplyOverflow_ReDerivesTheDriftedRow_AndPublishesItsCorrection()
    {
        var text = File.ReadAllText(_mod.NpcSourceFile);
        File.WriteAllText(
            _mod.NpcSourceFile, text.Replace("\"FixtureNpc\"", "\"EditedWhileRunning\"", StringComparison.Ordinal));

        var index = new ExternalChangeApplier(_mod.Index, _mod.Holder, _notifications, NullLogger.Instance);
        index.ApplyOverflow(_mod.ModFolder, IndexedModFixture.PluginName);

        Assert.Equal(
            "EditedWhileRunning",
            _mod.Index.Store!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.EditorId);
        // A single edited field drifts one row, not the whole document set — Validate's own
        // RowsChangedNotification, not ApplyOverflow's NeedsRebuild branch.
        Assert.Contains(_notifications.Notifications, n => n is RowsChangedNotification rc && rc.Plugin == _mod.Plugin);
    }

    [Fact]
    public void ApplyOverflow_PublishesNothing_WhenTheTrackedSourceHasNotDrifted()
    {
        var index = new ExternalChangeApplier(_mod.Index, _mod.Holder, _notifications, NullLogger.Instance);

        index.ApplyOverflow(_mod.ModFolder, IndexedModFixture.PluginName);

        Assert.Empty(_notifications.Notifications);
    }
}
