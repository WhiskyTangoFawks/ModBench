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
    public (ILoadOrder LoadOrder, IRecordReads Reads) RequireScope() => inner.RequireScope();
    public void Reconcile(
        string gameDirectory, IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease,
        string? instanceRoot = null) =>
        inner.Reconcile(gameDirectory, plugins, gameRelease, instanceRoot);
    public void Close() => inner.Close();
    public PluginResponse CreatePlugin(string name, string path, string origin) => inner.CreatePlugin(name, path, origin);
    public Task ReindexPlugin(PluginKey key) => inner.ReindexPlugin(key);
    public void ReingestPluginFromSource(PluginKey key) => inner.ReingestPluginFromSource(key);
    public void UnindexPlugin(PluginKey key) => inner.UnindexPlugin(key);
    public void SetFilter(string sql) => inner.SetFilter(sql);
    public void ClearFilter() => inner.ClearFilter();
    public void ReapplyFilter() => inner.ReapplyFilter();
}
