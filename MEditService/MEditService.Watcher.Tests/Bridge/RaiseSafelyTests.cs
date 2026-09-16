using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using MEditService.Watcher;
using Microsoft.Extensions.Logging;

namespace MEditService.Tests.Bridge;

/// <summary>ADR-0019: the timer/filesystem callback that raises a batch has no caller to propagate
/// an exception to, so the fault must reach the injected logger instead of vanishing.</summary>
public sealed class RaiseSafelyTests
{
    [Fact]
    public void RaiseSafely_AnActionThatThrows_LogsTheFaultRatherThanLosingIt()
    {
        var entries = new List<LogEntry>();
        using var watcher = new ModFolderWatcher(
            new LoadOrderHolder(), new RecordingRefreshIndex(), new InMemoryNotificationPublisher(),
            new CollectingLogger(entries));

        watcher.RaiseSafely(() => throw new InvalidOperationException("boom"));

        Assert.Contains(entries, e =>
            e.Level == LogLevel.Error
            && e.Message.Contains("failed unexpectedly", StringComparison.Ordinal)
            && e.Exception?.Message == "boom");
    }
}
