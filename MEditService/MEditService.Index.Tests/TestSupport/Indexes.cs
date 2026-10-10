using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>The Index as the host builds it: through the registration over the real adapter,
/// subscribed to its holder and reconciled over a fixture's plugins.</summary>
internal static class Indexes
{
    /// <summary>The registration over the real adapter, before anything has resolved the index. The
    /// fixtures' schema is discovered first, as the put-load-order handler does, so no reconcile a
    /// test waits on pays the discovery.</summary>
    internal static ServiceProvider Container(
        LoadOrderHolder holder,
        IPluginAdapter? adapter = null,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null,
        TimeProvider? timeProvider = null,
        ISourceAdapter? source = null)
    {
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        var services = new ServiceCollection();
        services.AddSingleton(holder);
        if (adapter is null) services.AddSingleton<IPluginAdapter, MutagenPluginAdapter>();
        else services.AddSingleton(adapter);
        services.AddSingleton<UnsavedDocuments>();
        if (source is null) services.AddSingleton<ISourceAdapter, GitSourceAdapter>();
        else services.AddSingleton(source);
        services.AddSingleton(SharedSchemaReflector.Instance);
        services.AddSingleton(loggerFactory ?? NullLoggerFactory.Instance);
        services.AddSingleton(timeProvider ?? TimeProvider.System);
        services.AddLogging();
        if (notifications is not null) services.AddSingleton(notifications);
        services.AddRecordIndex();
        return services.BuildServiceProvider();
    }

    internal static OpenedIndex Open(
        LoadOrderHolder holder,
        IPluginAdapter? adapter = null,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null,
        TimeProvider? timeProvider = null,
        ISourceAdapter? source = null) =>
        new(Container(holder, adapter, loggerFactory, notifications, timeProvider, source), holder);

    internal static OpenedIndex Reconciled(
        PluginFixtureData fixture,
        string? instanceRoot = null,
        IPluginAdapter? adapter = null,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null,
        ISourceAdapter? source = null) =>
        Reconciled(fixture.DataFolder, fixture.Plugins, instanceRoot, adapter, loggerFactory, notifications, source);

    internal static OpenedIndex Reconciled(
        ScatteredFixtureData fixture,
        string? instanceRoot = null,
        IPluginAdapter? adapter = null,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null,
        ISourceAdapter? source = null) =>
        Reconciled(fixture.GameDirectory, fixture.Plugins, instanceRoot, adapter, loggerFactory, notifications, source);

    internal static OpenedIndex Reconciled(
        string gameDirectory,
        IReadOnlyList<LoadOrderEntry> plugins,
        string? instanceRoot = null,
        IPluginAdapter? adapter = null,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null,
        ISourceAdapter? source = null)
    {
        var holder = new LoadOrderHolder();
        var index = Open(holder, adapter, loggerFactory, notifications, source: source);
        index.Reconcile(holder, gameDirectory, plugins, GameRelease.Fallout4, instanceRoot);
        // The door turns a refusal into status; a fixture built over one is not the fixture asked for.
        if (index.Status.State is LoadOrderState.HeldElsewhere or LoadOrderState.Failed)
        {
            var message = index.Status.Message;
            index.Dispose();
            throw new InvalidOperationException($"The fixture's reconcile was refused: {message}");
        }
        return index;
    }

    /// <summary>The held load order arriving again (ADR-0013), answered once
    /// <paramref name="announced"/> holds, its status is out and its validation has ended: an
    /// arrival that re-derived nothing shows that only in the write gate.</summary>
    internal static void NextSnapshotUntil(this OpenedIndex index, Func<bool> announced, string what)
    {
        index.NextSnapshotUnsettledUntil(announced, what);
        index.Settled();
    }

    /// <summary>The arrival, answered once <paramref name="announced"/> holds and its status is out:
    /// no pass through the write gate, which would re-apply the filter a test may be asserting on.
    /// </summary>
    internal static void NextSnapshotUnsettledUntil(this OpenedIndex index, Func<bool> announced, string what)
    {
        index.Holder.Apply(index.Holder.Current);
        Waits.Reached(announced, what);
        Waits.Reached(() => index.Status.State != LoadOrderState.Reconciling, "the arrival's status");
    }

    /// <summary>The held load order arriving again, answered once the rows it changed are announced
    /// as the sequence moving, which a projection does after it has re-applied the filter.</summary>
    internal static void NextSnapshot(this OpenedIndex index)
    {
        var before = index.Sequence;
        index.NextSnapshotUnsettledUntil(() => index.Sequence > before, "the sequence moving");
    }

    /// <summary>The SQL door: the filter is arbitrary SQL yielding form_key, so what it
    /// matches is the relational schema's own answer. The filter is cleared after, the door being
    /// shared.</summary>
    internal static int Matching(this OpenedIndex index, string sql)
    {
        index.SetFilter(sql, "filter.sql");
        try
        {
            return index.Records.GetRecords(types: null, plugin: null, search: null, limit: 1, offset: 0).Value().Total;
        }
        finally
        {
            index.ClearFilter();
        }
    }

    /// <summary>Whether a filter may name the relations and columns in <paramref name="sql"/>: the
    /// door refuses SQL it cannot resolve.</summary>
    internal static bool Accepts(this OpenedIndex index, string sql)
    {
        if (Record.Exception(() => index.SetFilter(sql, "filter.sql")) is not null) return false;
        index.ClearFilter();
        return true;
    }

    /// <summary>One record type's row count for one plugin, zero when the plugin holds none.</summary>
    internal static int CountOf(this OpenedIndex index, PluginAddress plugin, string recordType) =>
        index.Records.GetPluginRecordTypes(plugin).Value()
            .FirstOrDefault(c => string.Equals(c.Type, recordType, StringComparison.OrdinalIgnoreCase))?.Count ?? 0;
}
