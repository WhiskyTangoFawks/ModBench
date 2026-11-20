using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>The Index as the host builds it: through the registration over the real adapter,
/// subscribed to its holder and reconciled over a fixture's plugins.</summary>
internal static class Indexes
{
    /// <summary>The registration over the real adapter, before anything has resolved the record index. The
    /// fixtures' schema is discovered first, as the put-load-order handler does, so no reconcile a
    /// test waits on pays the discovery.</summary>
    internal static ServiceProvider Container(
        LoadOrderHolder holder,
        IPluginAdapter? adapter = null,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null,
        TimeProvider? timeProvider = null,
        ISourceAdapter? source = null,
        long? memoryLimit = null,
        UnsavedDocuments? unsaved = null)
    {
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        var services = new ServiceCollection();
        services.AddSingleton(holder);
        if (adapter is null) services.AddSingleton<IPluginAdapter, MutagenPluginAdapter>();
        else services.AddSingleton(adapter);
        services.AddSingleton(unsaved ?? new UnsavedDocuments());
        if (source is null) services.AddSingleton<ISourceAdapter, GitSourceAdapter>();
        else services.AddSingleton(source);
        services.AddSingleton(SharedSchemaReflector.Instance);
        services.AddSingleton(loggerFactory ?? TestOutput.LoggerFactory);
        services.AddSingleton(timeProvider ?? TimeProvider.System);
        services.AddLogging();
        if (notifications is not null) services.AddSingleton(notifications);
        services.AddRecordIndex(memoryLimit);
        return services.BuildServiceProvider();
    }

    internal static OpenedIndex Open(
        LoadOrderHolder holder,
        IPluginAdapter? adapter = null,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null,
        TimeProvider? timeProvider = null,
        ISourceAdapter? source = null,
        long? memoryLimit = null,
        UnsavedDocuments? unsaved = null) =>
        new(Container(holder, adapter, loggerFactory, notifications, timeProvider, source, memoryLimit, unsaved), holder);

    internal static OpenedIndex Reconciled(
        PluginFixtureData fixture,
        string? instanceRoot = null,
        IPluginAdapter? adapter = null,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null,
        ISourceAdapter? source = null,
        long? memoryLimit = null,
        TimeSpan? patience = null) =>
        Reconciled(fixture.DataFolder, fixture.Plugins, instanceRoot, adapter, loggerFactory, notifications, source, memoryLimit, patience);

    internal static OpenedIndex Reconciled(
        ScatteredFixtureData fixture,
        string? instanceRoot = null,
        IPluginAdapter? adapter = null,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null,
        ISourceAdapter? source = null,
        long? memoryLimit = null) =>
        Reconciled(fixture.DataFolder, fixture.Plugins, instanceRoot, adapter, loggerFactory, notifications, source, memoryLimit);

    internal static OpenedIndex Reconciled(
        string dataFolder,
        IReadOnlyList<LoadOrderEntry> plugins,
        string? instanceRoot = null,
        IPluginAdapter? adapter = null,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null,
        ISourceAdapter? source = null,
        long? memoryLimit = null,
        TimeSpan? patience = null,
        UnsavedDocuments? unsaved = null)
    {
        var holder = new LoadOrderHolder();
        var index = Open(holder, adapter, loggerFactory, notifications, source: source, memoryLimit: memoryLimit, unsaved: unsaved);
        try
        {
            index.Receive(holder, SnapshotPlugins.Snapshot(dataFolder, instanceRoot, GameRelease.Fallout4, plugins), patience);
            // The door turns a refusal into status; a fixture built over one is not the fixture asked for.
            if (index.Status.State is LoadOrderState.HeldElsewhere or LoadOrderState.Failed)
                throw new InvalidOperationException($"The fixture's reconcile was refused: {index.Status.Message}");
            return index;
        }
        catch
        {
            index.Dispose();
            throw;
        }
    }

    /// <summary>A change signalled, answered once <paramref name="announced"/> holds, its status is out and its
    /// validation has ended: a check that re-derived nothing shows that only in the write gate.</summary>
    internal static void NextCheckUntil(this OpenedIndex index, Func<bool> announced, string what)
    {
        index.NextCheckUnsettledUntil(announced, what);
        index.Settled();
        index.EndedClean();
    }

    /// <summary>The check, answered once <paramref name="announced"/> holds and its status is out:
    /// no pass through the write gate, which would re-apply the filter a test may be asserting on.
    /// A check that did not end clean fails the wait, naming why.</summary>
    internal static void NextCheckUnsettledUntil(this OpenedIndex index, Func<bool> announced, string what)
    {
        var standing = index.Status;
        index.NextCheckThatMayFailUnsettledUntil(() => announced() || FailedAnew(index.Status, standing), what);
        index.EndedClean();
        Waits.Reached(announced, what);
    }

    private static void EndedClean(this OpenedIndex index)
    {
        var status = index.Status;
        if (NotClean(status))
            Assert.Fail($"The check ended {status.State}: {status.Message}{Environment.NewLine}{string.Join(Environment.NewLine, status.Failures)}");
    }

    /// <summary><see cref="NextCheckUntil"/> for a test that reads the check's failure from the status itself.</summary>
    internal static void NextCheckThatMayFailUntil(this OpenedIndex index, Func<bool> announced, string what)
    {
        index.NextCheckThatMayFailUnsettledUntil(announced, what);
        index.Settled();
    }

    /// <summary><see cref="NextCheckUnsettledUntil"/> for a test that reads the check's failure from the status itself.</summary>
    internal static void NextCheckThatMayFailUnsettledUntil(this OpenedIndex index, Func<bool> announced, string what)
    {
        index.SignalChange();
        Waits.Reached(announced, what);
        Waits.Reached(() => index.Status.State != LoadOrderState.Reconciling, "the check's status");
    }

    private static bool NotClean(LoadOrderStatus status) =>
        status.State is not (LoadOrderState.Ready or LoadOrderState.Reconciling) || status.Failures.Count > 0;

    private static bool FailedAnew(LoadOrderStatus status, LoadOrderStatus standing) =>
        status.State != LoadOrderState.None && NotClean(status)
        && !(status.State == standing.State && status.Failures.SequenceEqual(standing.Failures));

    /// <summary>Checks the disk until the index is Ready and <paramref name="recovered"/> holds: after a fatal error the
    /// next check reopens the store (ADR-0003).</summary>
    internal static void Recovered(this OpenedIndex index, Func<bool> recovered, string what) =>
        Waits.Reached(() =>
        {
            var status = index.Status;
            if (status.Validating || status.State == LoadOrderState.Reconciling) return false;
            if (status.State == LoadOrderState.Ready && recovered()) return true;
            index.SignalChange();
            return false;
        }, what);

    /// <summary>A change signalled, answered once the rows it changed are announced as the sequence moving, which a
    /// projection does after it has re-applied the filter.</summary>
    internal static void NextCheck(this OpenedIndex index)
    {
        var before = index.Sequence;
        index.NextCheckUnsettledUntil(() => index.Sequence > before, "the sequence moving");
    }

    /// <summary><see cref="NextCheck"/> for a test that reads the check's failure from the status itself.</summary>
    internal static void NextCheckThatMayFail(this OpenedIndex index)
    {
        var before = index.Sequence;
        index.NextCheckThatMayFailUnsettledUntil(() => index.Sequence > before, "the sequence moving");
    }

    /// <summary>The SQL door: the filter is arbitrary SQL yielding form_key, so what it
    /// matches is the relational schema's own answer. The filter is cleared after, the door being
    /// shared.</summary>
    internal static int Matching(this OpenedIndex index, string sql)
    {
        index.SetFilter(sql, "filter.sql");
        try
        {
            return index.Queries.GetRecords(types: null, plugin: null, search: null, limit: 1, offset: 0).Value().Total;
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
        index.Queries.GetPluginRecordTypes(plugin).Value()
            .FirstOrDefault(c => string.Equals(c.Type, recordType, StringComparison.OrdinalIgnoreCase))?.Count ?? 0;
}
