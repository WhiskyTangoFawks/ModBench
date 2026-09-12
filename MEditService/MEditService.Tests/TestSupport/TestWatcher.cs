using MEditService.Watcher;
using MEditService.Ports;
using MEditService.LoadOrder;
using MEditService.Index;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.TestSupport;

/// <summary>The composition root's own wiring of the watcher, so a suite states the holder, the
/// Index and the port it cares about and nothing else.</summary>
internal static class TestWatcher
{
    internal static ModFolderWatcher Over(
        LoadOrderHolder holder,
        IRefreshIndex index,
        INotificationPublisher notifications,
        TimeSpan? quiet = null,
        TimeSpan? maxWindow = null) =>
        new(holder, index, notifications, NullLogger.Instance, quiet, maxWindow);

    /// <summary>For a suite whose subject is an endpoint rather than the watch: nothing is armed, so
    /// nothing routes anywhere.</summary>
    internal static ModFolderWatcher Inert() =>
        Over(new LoadOrderHolder(), new RecordingRefreshIndex(), new InMemoryNotificationPublisher());
}
