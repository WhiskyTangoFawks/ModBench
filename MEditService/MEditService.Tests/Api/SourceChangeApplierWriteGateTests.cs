using MEditService.Api;
using MEditService.Bridge;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>ADR-0026: a write-gate timeout on a settled batch is logged, never swallowed — the
/// timer callback that raises it has no caller to propagate an exception to.</summary>
public sealed class SourceChangeApplierWriteGateTests
{
    [Fact]
    public async Task Apply_LogsRatherThanLosesTheBatch_WhenAnotherWriterHoldsTheGate()
    {
        var holder = new LoadOrderHolder();
        var gate = new IndexWriteGate(TimeSpan.FromMilliseconds(100));
        var entries = new List<LogEntry>();
        // The Index is never reached: the gate refuses before the first plugin in the batch is
        // projected, which is the whole of what this asserts.
        using var index = new IndexProjector(holder, MutagenPluginAdapter.Instance, new RefusingIndexFactory());
        var sourceChanges = new SourceChangeApplier(
            index, holder, gate, new ModFolderWatcher(), new InMemoryNotificationPublisher(),
            new CollectingLogger(entries));

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
        var thrown = Record.Exception(() => sourceChanges.Apply([change]));

        release.Set();
        await otherWriter.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Null(thrown);
        Assert.Contains(entries, e => e.Level == LogLevel.Warning
            && e.Message.Contains("Locked.esp", StringComparison.Ordinal)
            && e.Message.Contains("re-checked", StringComparison.Ordinal));
    }
}
