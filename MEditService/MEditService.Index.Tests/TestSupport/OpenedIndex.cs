using MEditService.LoadOrder;
using MEditService.Ports;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests;

/// <summary>The index a host gets from the registration, with the holder its arrivals are sent
/// through, and the container that owns it.</summary>
internal sealed class OpenedIndex(IQueryIndex index, LoadOrderHolder holder, IDisposable container) : IQueryIndex, IDisposable
{
    internal LoadOrderHolder Holder { get; } = holder;

    public LoadOrderStatus Status => index.Status;

    public (string Sql, string Source)? ActiveFilter => index.ActiveFilter;

    public long Sequence => index.Sequence;

    public Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout) => index.AwaitSequenceAsync(atLeast, timeout);

    public IRecordReads RequireReads() => index.RequireReads();

    public void SetFilter(string sql, string source) => index.SetFilter(sql, source);

    public void ClearFilter() => index.ClearFilter();

    public StoreRebuild RebuildStore(GameRelease gameRelease, string instanceRoot) => index.RebuildStore(gameRelease, instanceRoot);

    /// <summary>Returns once a write in flight has finished: setting the filter again passes the write
    /// gate every write passes.</summary>
    internal void Settled()
    {
        if (ActiveFilter is var (sql, source)) SetFilter(sql, source);
        else ClearFilter();
    }

    public void Dispose() => container.Dispose();
}
