using MEditService.Commands.Composition;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Watcher;
using Microsoft.Extensions.DependencyInjection;
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
        new(holder, index, notifications, Settled(notifications), NullLogger.Instance, quiet, maxWindow);

    /// <summary>The watcher's verb as the composition root builds it: over the same port the
    /// suite reads, so what Commands publishes is what the suite sees.</summary>
    internal static TrackedModSettled Settled(INotificationPublisher notifications) =>
        new ServiceCollection()
            .AddSingleton(notifications)
            .AddCommandHandlers()
            .BuildServiceProvider()
            .GetRequiredService<TrackedModSettled>();

    /// <summary>For a suite whose subject is an endpoint rather than the watch: nothing is armed, so
    /// nothing routes anywhere.</summary>
    internal static ModFolderWatcher Inert() =>
        Over(new LoadOrderHolder(), new RecordingRefreshIndex(), new InMemoryNotificationPublisher());
}
