using MEditService.Watcher;
using MEditService.LoadOrder;
using MEditService.Index;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;

namespace MEditService.Tests.Bridge;

/// <summary>ADR-0019: a write-gate timeout on a settled batch is logged, never swallowed — the
/// timer callback that raises it has no caller to propagate an exception to.</summary>
public sealed class SourceBatchWriteGateTests
{
    [Fact]
    public async Task ASettledBatch_IsLoggedRatherThanLost_WhenAnotherWriterHoldsTheGate()
    {
        var gate = new IndexWriteGate(TimeSpan.FromMilliseconds(100));
        var entries = new List<LogEntry>();
        // The Index is never reached: the gate refuses before the first plugin in the batch is
        // projected, which is the whole of what this asserts.
        var index = new RecordingRefreshIndex { WriteGate = gate };
        using var watcher = new ModFolderWatcher(
            new LoadOrderHolder(), index, new InMemoryNotificationPublisher(), new CollectingLogger(entries));

        using var held = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var otherWriter = Task.Run(() =>
        {
            using var _ = gate.Enter();
            held.Set();
            release.Wait(TimeSpan.FromSeconds(10));
        });
        Assert.True(held.Wait(TimeSpan.FromSeconds(5)), "the holder never took the gate");

        var change = new SourceChangeEvent("Locked.esp", "LockedMod", "/nonexistent", SourceChangeScope.WholePlugin, []);
        var thrown = Record.Exception(() => watcher.ProjectSourceBatch([change]));

        release.Set();
        await otherWriter.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Null(thrown);
        Assert.Empty(index.Projections);
        Assert.Contains(entries, e => e.Level == LogLevel.Warning
            && e.Message.Contains("Locked.esp", StringComparison.Ordinal)
            && e.Message.Contains("re-checked", StringComparison.Ordinal));
    }
}
