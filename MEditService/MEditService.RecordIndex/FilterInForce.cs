using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using Microsoft.Extensions.Logging;

namespace MEditService.RecordIndex;

/// <summary>The record filter in force and the source its SQL came from. It clears on purpose or when it
/// cannot apply again (plugins.md, States, story 7): a rebuild of its scope keeps it, another scope drops it.</summary>
internal sealed class FilterInForce(ILogger logger, INotificationPublisher? notifications)
{
    private readonly Lock _lock = new();
    private (string Sql, string Source, IndexScope Scope)? _current;

    public RecordFilter? Current
    {
        get { lock (_lock) return _current is { } filter ? new RecordFilter(filter.Sql, filter.Source) : null; }
    }

    /// <summary>Answers why the SQL cannot be a filter, such as no form_key column, leaving the one in force.
    /// Throws <see cref="NoLoadOrderException"/> with no store to hold it.</summary>
    public string? Set(Indexer index, string sql, string source) =>
        index.InForce(store => Materialize(store, (sql, source)), () => throw new NoLoadOrderException());

    /// <summary>A filter that is reported must clear, store or no store.</summary>
    public void Clear(Indexer index) => index.InForce(store => Materialize(store, null), () =>
    {
        lock (_lock) _current = null;
        return null;
    });

    private string? Materialize(GatedStore store, (string Sql, string Source)? filter)
    {
        lock (_lock)
        {
            if (store.SetFilter(filter?.Sql) is { } rejection) return rejection;
            _current = filter is { } set ? (set.Sql, set.Source, store.Scope) : null;
            return null;
        }
    }

    public void DropWhenOutside(LoadOrderSnapshot snapshot)
    {
        lock (_lock)
        {
            if (_current is { } filter && !filter.Scope.Matches(snapshot)) _current = null;
        }
    }

    /// <summary>Materializes the filter in force again after rows moved, or none: a store opened while a
    /// clear waited still holds the cleared one. One that cannot apply again is cleared and published.</summary>
    public void Reapply(Store.Store store)
    {
        if (ReapplyOrClear(store) is { } cleared) notifications?.Publish(cleared);
    }

    private RecordFilterClearedNotification? ReapplyOrClear(Store.Store store)
    {
        lock (_lock)
        {
            if (_current is not { } filter)
            {
                store.Filter.Set(null);
                return null;
            }
            if (store.Filter.Set(filter.Sql) is not { } rejection) return null;
            logger.LogWarning(
                "Could not re-materialize the active filter ({Error}); the filter is cleared", rejection);
            store.Filter.Set(null);
            _current = null;
            return new RecordFilterClearedNotification(filter.Source, rejection);
        }
    }
}
