using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Store;

/// <summary>A <see cref="Store"/> per game, opened over the calling instance's file when it names one, and
/// closed. Another window holding the file answers a refusal (ADR-0010). Callers take turns under the
/// Indexer's exclusive right.</summary>
internal sealed class StoreFactory(
    SchemaReflector schemaReflector,
    TableDdlBuilder ddlBuilder,
    IPluginAdapter plugins,
    ISourceAdapter source,
    IndexWriteGate gate,
    FilterInForce filter,
    INotificationPublisher? notifications,
    ILogger<StoreFactory>? logger = null,
    TimeProvider? timeProvider = null) : IDisposable
{
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    // DuckDB.NET keeps one database instance per path while any connection on it is open, so a store
    // opened beside a closed store's open read answers the closed store's rows, even once a rebuild
    // deleted the file.
    private Store? _undrained;

    /// <summary>A null <paramref name="instanceRoot"/> means an in-memory store that dies with this
    /// object. <paramref name="openedPlugins"/> answers <see cref="RelationReads.OpenedPlugins"/>;
    /// <paramref name="indexed"/> says whether the whole set is read.</summary>
    public Store? Create(
        GameRelease gameRelease, string? instanceRoot,
        Func<IReadOnlyDictionary<PluginAddress, PluginContent>> openedPlugins, Func<bool> indexed, out string? refusal)
    {
        var store = Open(gameRelease, instanceRoot, openedPlugins, indexed, atLeastSequence: null, out refusal);
        try
        {
            store?.ValidateAgainstDisk();
            var validated = store;
            store = null;
            return validated;
        }
        finally
        {
            store?.Dispose();
        }
    }

    /// <summary>The refusal, or null once the file is rebuilt and released. The reopened sequence is floored at
    /// <paramref name="atLeastSequence"/>: this process may already have answered a caller with a
    /// higher value, and Sequence must never regress.</summary>
    public string? Rebuild(GameRelease gameRelease, string instanceRoot, long atLeastSequence)
    {
        using var store = Open(
            gameRelease, instanceRoot, () => new Dictionary<PluginAddress, PluginContent>(), () => false, atLeastSequence, out var refusal);
        return refusal;
    }

    /// <summary>Closes <paramref name="leaving"/>, or the store a read kept open, ahead of a store for
    /// <paramref name="opening"/>. False when a read on that file outlives the drain: the next close
    /// drains it again.</summary>
    public bool Close(Store? leaving, string? opening) => Close(leaving, closing => closing.SharesFileWith(opening));

    /// <summary>The same, ahead of a store on any file.</summary>
    public bool Close(Store? leaving) => Close(leaving, _ => true);

    private bool Close(Store? leaving, Func<Store, bool> sharesTheNextFile)
    {
        var closing = leaving ?? _undrained;
        _undrained = null;
        if (closing is null) return true;
        if (sharesTheNextFile(closing) && !closing.EndReads())
        {
            _undrained = closing;
            return false;
        }
        closing.Dispose();
        return true;
    }

    public void Dispose() => _undrained?.Dispose();

    private Store? Open(
        GameRelease gameRelease, string? instanceRoot,
        Func<IReadOnlyDictionary<PluginAddress, PluginContent>> openedPlugins, Func<bool> indexed,
        long? atLeastSequence, out string? refusal)
    {
        var store = new Store(
            _logger, instanceRoot is null ? null : IndexFile.For(instanceRoot), instanceRoot, schemaReflector, ddlBuilder, plugins,
            timeProvider, openedPlugins, indexed, gate, filter, notifications);
        try { refusal = store.Open(); }
        catch
        {
            store.Dispose();
            throw;
        }
        if (refusal is not null)
        {
            store.Dispose();
            return null;
        }

        // ADR-0010: a rebuild's whole job on an opened file, which the open already refused if
        // another process held it.
        if (atLeastSequence is not null) store.RebuildFile();
        store.Initialize(gameRelease, source.ContentStamp);
        if (atLeastSequence is { } floor) store.SeedSequence(floor);
        return store;
    }
}
