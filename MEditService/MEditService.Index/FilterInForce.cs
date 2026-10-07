using System.Data.Common;
using MEditService.LoadOrder;
using Microsoft.Extensions.Logging;
using MEditService.Ports;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>Where an index was opened: the game, its Data folder and the instance whose file holds it.</summary>
internal readonly record struct IndexScope(GameRelease GameRelease, string DataFolderPath, string? InstanceRoot)
{
    internal static IndexScope Of(HeldPlugins held) => new(held.GameRelease, held.DataFolderPath, held.InstanceRoot);

    internal bool Matches(LoadOrderSnapshot snapshot) =>
        GameRelease == snapshot.GameRelease
        && SamePath(DataFolderPath, snapshot.DataFolderPath)
        && (InstanceRoot, snapshot.InstanceRoot) switch
        {
            (null, null) => true,
            ({ } a, { } b) => SamePath(a, b),
            _ => false,
        };

    private static bool SamePath(string a, string b) =>
        string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
}

/// <summary>The record filter in force and the source its SQL came from. It clears on purpose or when it
/// cannot apply again (plugins.md, States, story 7): a rebuild of its scope keeps it, another scope drops it.</summary>
internal sealed class FilterInForce(ILogger logger, INotificationPublisher? notifications)
{
    private readonly Lock _lock = new();
    private (string Sql, string Source, IndexScope Scope)? _current;

    public (string Sql, string Source)? Current
    {
        get { lock (_lock) return _current is { } filter ? (filter.Sql, filter.Source) : null; }
    }

    /// <summary>Materializes <paramref name="filter"/> in <paramref name="index"/> and holds it for
    /// <paramref name="scope"/>; null clears both. Throws what the index's door throws.</summary>
    public void Set(DuckDbRecordIndex index, IndexScope scope, (string Sql, string Source)? filter)
    {
        lock (_lock)
        {
            index.SetFilter(filter?.Sql);
            _current = filter is { } set ? (set.Sql, set.Source, scope) : null;
        }
    }

    /// <summary>Clears the filter with no index to clear it in: one that is reported must clear, store
    /// or no store.</summary>
    public void Clear()
    {
        lock (_lock) _current = null;
    }

    public void DropWhenOutside(LoadOrderSnapshot snapshot)
    {
        lock (_lock)
        {
            if (_current is { } filter && !filter.Scope.Matches(snapshot)) _current = null;
        }
    }

    /// <summary>Materializes the filter again after rows moved. A filter that cannot apply again is
    /// cleared and published: the write it follows is durable, and a filtered table left over the old
    /// rows would answer wrongly while the filter still showed as active.</summary>
    public void Reapply(DuckDbRecordIndex index)
    {
        if (ReapplyOrClear(index) is { } cleared) notifications?.Publish(cleared);
    }

    private RecordFilterClearedNotification? ReapplyOrClear(DuckDbRecordIndex index)
    {
        lock (_lock)
        {
            if (_current is not { } filter) return null;
            try
            {
                index.SetFilter(filter.Sql);
                return null;
            }
            catch (DbException ex)
            {
                logger.LogWarning(ex,
                    "Could not re-materialize the active filter ({Error}); the filter is cleared", ex.Message);
                index.SetFilter(null);
                _current = null;
                return new RecordFilterClearedNotification(filter.Source, ex.Message);
            }
        }
    }
}
