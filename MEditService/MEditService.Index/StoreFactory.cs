using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>A <see cref="Store"/> per game, opened over the calling instance's persistent file when it
/// names one. Another window holding the file answers a refusal and no store (ADR-0010).</summary>
internal sealed class StoreFactory(
    SchemaReflector schemaReflector,
    TableDdlBuilder ddlBuilder,
    IPluginAdapter plugins,
    IndexWriteGate gate,
    FilterInForce filter,
    INotificationPublisher? notifications,
    ILogger<StoreFactory>? logger = null,
    TimeProvider? timeProvider = null)
{
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    /// <summary>A null <paramref name="instanceRoot"/> means an in-memory store that dies with this
    /// object. <paramref name="openedPlugins"/> answers <see cref="IRecordReads.OpenedPlugins"/>;
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

    private Store? Open(
        GameRelease gameRelease, string? instanceRoot,
        Func<IReadOnlyDictionary<PluginAddress, PluginContent>> openedPlugins, Func<bool> indexed,
        long? atLeastSequence, out string? refusal)
    {
        var store = new Store(
            _logger, instanceRoot is null ? null : IndexFile.For(instanceRoot), schemaReflector, ddlBuilder, plugins,
            timeProvider, openedPlugins, indexed, gate, filter, notifications);
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
