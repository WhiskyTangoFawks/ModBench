using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.RecordIndex.Tests;

/// <summary>The record index a host gets from the registration: its face, with
/// the holder its arrivals are sent through, and the container that owns it.</summary>
internal sealed class OpenedIndex(ServiceProvider container, LoadOrderHolder holder) : IDisposable
{
    internal LoadOrderHolder Holder { get; } = holder;

    internal UnsavedDocuments Unsaved { get; } = container.GetRequiredService<UnsavedDocuments>();

    /// <summary>A document typed as VS Code does: held, then handed to the plugins whose trees hold it, and returned once the
    /// index has read it.</summary>
    internal void TypeUnsaved(DocumentChange document)
    {
        Unsaved.Typed(document);
        HandOver(document.Path);
    }

    /// <summary>A document closed as VS Code does: dropped, so its file is read again.</summary>
    internal void CloseUnsaved(string path)
    {
        Unsaved.Closed(path);
        HandOver(path);
    }

    private void HandOver(string path)
    {
        var handed = container.GetRequiredService<ISourceAdapter>().Touching(Holder.Current, path) switch
        {
            PathAnswer.Touches touches => touches.Plugins.Select(plugin => new HandedPlugin(plugin.Key, [path], [])).ToList(),
            PathAnswer.Unnamed => null,
            _ => [],
        };
        Queries.Hold(handed, CancellationToken.None).GetAwaiter().GetResult();
    }

    internal IQueries Queries { get; } = container.GetRequiredService<IQueries>();

    internal LoadOrderStatus Status => Queries.GetStatus();

    internal long Sequence => Queries.GetSequence();

    internal void SetFilter(string sql, string source) => Queries.SetFilter(sql, source).Accepted();

    internal void ClearFilter() => Queries.ClearFilter();

    /// <summary>A change signalled as Signal change signals it, through the source adapter.</summary>
    internal void SignalChange() => container.GetRequiredService<ISourceAdapter>().SignalChange(null);

    /// <summary>A change signalled as Signal change signals one whose paths name <paramref name="plugins"/>.</summary>
    internal void SignalChange(IReadOnlyList<PluginAddress> plugins) =>
        SignalChange([.. plugins.Select(plugin => new PluginChange(plugin, null))]);

    /// <summary>A change signalled as Signal change signals one whose paths name <paramref name="changes"/>' files.</summary>
    internal void SignalChange(IReadOnlyCollection<PluginChange> changes) => container.GetRequiredService<ISourceAdapter>().SignalChange(changes);

    /// <summary>Returns once a write in flight has finished: setting the filter again passes the write
    /// gate every write passes, and a validation announces inside its hold. With no store open, no
    /// write is in flight.</summary>
    internal void Settled()
    {
        if (!Queries.GetFilter().Holds(out var filter, out _)) return;
        if (filter is not null) SetFilter(filter.Sql, filter.Source);
        else ClearFilter();
    }

    public void Dispose() => container.Dispose();
}
