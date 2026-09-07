using MEditService.Api;
using MEditService.Bridge;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>ADR-0026: a write-gate timeout on a settled batch is logged, never swallowed — the
/// timer callback that raises it has no caller to propagate an exception to.</summary>
public sealed class SourceMirrorWriteGateTests
{
    [Fact]
    public async Task Apply_LogsRatherThanLosesTheBatch_WhenAnotherWriterHoldsTheGate()
    {
        var gate = new IndexWriteGate(TimeSpan.FromMilliseconds(100));
        var entries = new List<LogEntry>();
        var sourceMirror = new SourceMirror(
            new GateOnlyMirror(gate), new SourceChangeWatcher(), new InMemoryNotificationPublisher(),
            new CollectingLogger(entries));

        using var held = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var holder = Task.Run(() =>
        {
            using var _ = gate.Enter();
            held.Set();
            release.Wait(TimeSpan.FromSeconds(10));
        });
        Assert.True(held.Wait(TimeSpan.FromSeconds(5)), "the holder never took the gate");

        var change = new SourceChangeEvent("Locked.esp", "LockedMod", "/nonexistent", SourceChangeScope.WholePlugin, []);
        var thrown = Record.Exception(() => sourceMirror.Apply([change]));

        release.Set();
        await holder.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Null(thrown);
        Assert.Contains(entries, e => e.Level == LogLevel.Warning
            && e.Message.Contains("Locked.esp", StringComparison.Ordinal)
            && e.Message.Contains("re-checked", StringComparison.Ordinal));
    }

    // WriteGate is the only member Apply's gate-timeout path reaches before ApplyOne would run;
    // every other member is unreachable from this test and throws if that ever changes.
    private sealed class GateOnlyMirror(IndexWriteGate gate) : ILoadOrderMirror
    {
        public IndexWriteGate WriteGate => gate;
        public ILoadOrder? LoadOrder => throw new NotImplementedException();
        public IRecordReads? Reads => throw new NotImplementedException();
        public IRecordIndex? Index => throw new NotImplementedException();
        public LoadOrderStatus Status => throw new NotImplementedException();
        public long Sequence => throw new NotImplementedException();
        public Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout) => throw new NotImplementedException();
        public IDisposable BeginProjection() => throw new NotImplementedException();
        public void Announce(Action publish) => throw new NotImplementedException();
        public (ILoadOrder LoadOrder, IRecordReads Reads) RequireScope() => throw new NotImplementedException();
        public void Reconcile(
            string gameDirectory, IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease,
            string? instanceRoot = null) =>
            throw new NotImplementedException();
        public void Close() => throw new NotImplementedException();
        public PluginResponse CreatePlugin(string name, string path, string origin) => throw new NotImplementedException();
        public IReadOnlyList<ValidationReport> ValidateIndex(PluginKey? plugin) => throw new NotImplementedException();
        public void RefreshKeys(PluginKey key, IReadOnlyList<string> formKeys) => throw new NotImplementedException();
        public Action? LoadOrderChanged { get => throw new NotImplementedException(); set => throw new NotImplementedException(); }
        public Task ReindexPlugin(PluginKey key) => throw new NotImplementedException();
        public void UnindexPlugin(PluginKey key) => throw new NotImplementedException();
        public void SetFilter(string sql) => throw new NotImplementedException();
        public void ClearFilter() => throw new NotImplementedException();
        public void ReapplyFilter() => throw new NotImplementedException();
    }
}
