using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>A <see cref="DuckDbRecordIndex"/> per game, opened over the calling instance's persistent
/// file when it names one. Another window holding the file answers a refusal and no index
/// (ADR-0010).</summary>
internal sealed class DuckDbRecordIndexFactory(
    SchemaReflector schemaReflector,
    TableDdlBuilder ddlBuilder,
    IndexWriteGate gate,
    FilterInForce filter,
    INotificationPublisher? notifications,
    ILogger<DuckDbRecordIndexFactory>? logger = null,
    TimeProvider? timeProvider = null)
{
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    /// <summary>A null <paramref name="instanceRoot"/> means an in-memory index that dies with this
    /// object. <paramref name="openedPlugins"/> is what the index's reads answer
    /// <see cref="IRecordReads.OpenedPlugins"/> with.</summary>
    public DuckDbRecordIndex? Create(
        GameRelease gameRelease, string? instanceRoot,
        Func<IReadOnlyDictionary<PluginAddress, PluginContent>> openedPlugins, out string? refusal)
    {
        var store = Open(gameRelease, instanceRoot, openedPlugins, atLeastSequence: null, out refusal);
        try
        {
            if (store is null) return null;
            var index = new DuckDbRecordIndex(store, gate, filter, notifications, _logger);
            store = null;
            return index;
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
            gameRelease, instanceRoot, () => new Dictionary<PluginAddress, PluginContent>(), atLeastSequence, out var refusal);
        return refusal;
    }

    private Store? Open(
        GameRelease gameRelease, string? instanceRoot,
        Func<IReadOnlyDictionary<PluginAddress, PluginContent>> openedPlugins,
        long? atLeastSequence, out string? refusal)
    {
        var store = new Store(
            _logger, instanceRoot is null ? null : IndexFile.For(instanceRoot), schemaReflector, ddlBuilder,
            timeProvider, openedPlugins);
        refusal = store.Open();
        if (refusal is not null)
        {
            store.Dispose();
            return null;
        }

        // ADR-0010: a rebuild's whole job on an opened file, which the open already refused if
        // another process held it.
        if (atLeastSequence is not null) store.RebuildFile();
        store.Initialize(gameRelease);
        if (atLeastSequence is { } floor) store.SeedSequence(floor);
        return store;
    }
}
