using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Tests;

/// <summary>Forwards every member except <see cref="Index"/>: the only way to hand
/// <c>RecordEditService</c> an intercepted index, since <c>LoadOrderMirror</c>'s getter has no
/// setter a test can reach.</summary>
internal sealed class IndexOverridingMirror(ILoadOrderMirror inner, IRecordIndex overrideIndex) : ILoadOrderMirror
{
    public ILoadOrder? LoadOrder => inner.LoadOrder;
    public IRecordReads? Reads => inner.Reads;
    public IRecordIndex? Index => overrideIndex;
    // The real mirror's gate, not one of this double's own: everything under test still
    // serializes against the same object production would use.
    public IndexWriteGate WriteGate => inner.WriteGate;
    public LoadOrderStatus Status => inner.Status;
    // overrideIndex's own count, not inner's: a test intercepting Index wants the sequence its
    // double advances, not whatever inner's real (unused) index sits at.
    public long Sequence => overrideIndex.Sequence;
    public async Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout)
    {
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        while (overrideIndex.Sequence < atLeast)
        {
            if (stopwatch.Elapsed >= timeout) return false;
            await Task.Delay(TimeSpan.FromMilliseconds(20)).ConfigureAwait(false);
        }
        return true;
    }
    public (ILoadOrder LoadOrder, IRecordReads Reads) RequireScope() => inner.RequireScope();
    public void Reconcile(
        string gameDirectory, IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease,
        string? instanceRoot = null) =>
        inner.Reconcile(gameDirectory, plugins, gameRelease, instanceRoot);
    public void Close() => inner.Close();
    public PluginResponse CreatePlugin(string name, string path, string origin) => inner.CreatePlugin(name, path, origin);
    public Task ReindexPlugin(PluginKey key) => inner.ReindexPlugin(key);
    public IReadOnlyList<ValidationReport> ValidateIndex(PluginKey? plugin) => inner.ValidateIndex(plugin);
    public void RefreshKeys(PluginKey key, IReadOnlyList<string> formKeys) => inner.RefreshKeys(key, formKeys);
    public Action? LoadOrderChanged { get => inner.LoadOrderChanged; set => inner.LoadOrderChanged = value; }
    public void ReingestPluginFromSource(PluginKey key) => inner.ReingestPluginFromSource(key);
    public void UnindexPlugin(PluginKey key) => inner.UnindexPlugin(key);
    public void SetFilter(string sql) => inner.SetFilter(sql);
    public void ClearFilter() => inner.ClearFilter();
    public void ReapplyFilter() => inner.ReapplyFilter();
}
