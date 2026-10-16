using MEditService.Index.Queries;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Index.Tests;

/// <summary>The record index a host gets from the registration: its face, with
/// the holder its arrivals are sent through, and the container that owns it.</summary>
internal sealed class OpenedIndex(ServiceProvider container, LoadOrderHolder holder) : IDisposable
{
    internal LoadOrderHolder Holder { get; } = holder;

    internal UnsavedDocuments Unsaved { get; } = container.GetRequiredService<UnsavedDocuments>();

    internal IQueries Queries { get; } = container.GetRequiredService<IQueries>();

    internal LoadOrderStatus Status => Queries.GetStatus();

    internal long Sequence => Queries.GetSequence();

    internal void SetFilter(string sql, string source) => Queries.SetFilter(sql, source).Accepted();

    internal void ClearFilter() => Queries.ClearFilter();

    /// <summary>Returns once a write in flight has finished: setting the filter again passes the write
    /// gate every write passes, and a validation announces inside its hold. With no store open, no
    /// write is in flight.</summary>
    internal void Settled()
    {
        if (!Queries.GetFilter().Holds(out var filter, out _)) return;
        if (filter is var (sql, source)) SetFilter(sql, source);
        else ClearFilter();
    }

    public void Dispose() => container.Dispose();
}
