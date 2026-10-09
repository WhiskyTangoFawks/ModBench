using MEditService.Index.Queries;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Index.Tests;

/// <summary>The record index a host gets from the registration: its face, the query services, with
/// the holder its arrivals are sent through, and the container that owns it.</summary>
internal sealed class OpenedIndex(ServiceProvider container, LoadOrderHolder holder) : IDisposable
{
    internal LoadOrderHolder Holder { get; } = holder;

    internal UnsavedDocuments Unsaved { get; } = container.GetRequiredService<UnsavedDocuments>();

    internal IRecordQueryService Records { get; } = container.GetRequiredService<IRecordQueryService>();

    internal IWorldspaceQueryService Worldspaces { get; } = container.GetRequiredService<IWorldspaceQueryService>();

    internal ContainerChildQueryService Containers { get; } = container.GetRequiredService<ContainerChildQueryService>();

    internal MalformedPluginQueryService Malformed { get; } = container.GetRequiredService<MalformedPluginQueryService>();

    internal PluginDependantsQueryService Dependants { get; } = container.GetRequiredService<PluginDependantsQueryService>();

    internal PluginProblemQueryService Problems { get; } = container.GetRequiredService<PluginProblemQueryService>();

    internal LoadOrderStatus Status => Records.GetStatus();

    internal long Sequence => Records.GetSequence();

    internal void SetFilter(string sql, string source) => Records.SetFilter(sql, source);

    internal void ClearFilter() => Records.ClearFilter();

    /// <summary>Returns once a write in flight has finished: setting the filter again passes the write
    /// gate every write passes, and a validation announces inside its hold. With no store open, no
    /// write is in flight.</summary>
    internal void Settled()
    {
        (string Sql, string Source)? filter;
        try
        {
            filter = Records.GetFilter();
        }
        catch (NoLoadOrderException)
        {
            return;
        }
        if (filter is var (sql, source)) SetFilter(sql, source);
        else ClearFilter();
    }

    public void Dispose() => container.Dispose();
}
