using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>The Index as the composition root builds it: the public constructor over the real
/// adapter, reconciled over a fixture's plugins.</summary>
internal static class Indexes
{
    internal static IndexProjector Open(
        LoadOrderHolder holder,
        IPluginAdapter? adapter = null,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null) =>
        new(holder, adapter ?? MutagenPluginAdapter.Instance, SharedSchemaReflector.Instance, loggerFactory, notifications);

    internal static IndexProjector Reconciled(
        PluginFixtureData fixture,
        string? instanceRoot = null,
        IPluginAdapter? adapter = null,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null) =>
        Reconciled(fixture.DataFolder, fixture.Plugins, instanceRoot, adapter, loggerFactory, notifications);

    internal static IndexProjector Reconciled(
        ScatteredFixtureData fixture,
        string? instanceRoot = null,
        IPluginAdapter? adapter = null,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null) =>
        Reconciled(fixture.GameDirectory, fixture.Plugins, instanceRoot, adapter, loggerFactory, notifications);

    internal static IndexProjector Reconciled(
        string gameDirectory,
        IReadOnlyList<LoadOrderEntry> plugins,
        string? instanceRoot = null,
        IPluginAdapter? adapter = null,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null)
    {
        var holder = new LoadOrderHolder();
        var index = Open(holder, adapter, loggerFactory, notifications);
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

    /// <summary>The SQL door (ADR-0011): the filter is arbitrary SQL yielding form_key, so what it
    /// matches is the relational schema's own answer. The filter is cleared after, the door being
    /// shared.</summary>
    internal static int Matching(this IndexProjector index, string sql)
    {
        index.SetFilter(sql);
        try
        {
            return index.RequireReads().Search(new RecordQuery(Limit: 1)).Total;
        }
        finally
        {
            index.ClearFilter();
        }
    }

    /// <summary>Whether a filter may name the relations and columns in <paramref name="sql"/>: the
    /// door refuses SQL it cannot resolve.</summary>
    internal static bool Accepts(this IndexProjector index, string sql)
    {
        if (Record.Exception(() => index.SetFilter(sql)) is not null) return false;
        index.ClearFilter();
        return true;
    }

    /// <summary>One record type's row count for one copy, zero when the copy holds none.</summary>
    internal static int CountOf(this IRecordReads reads, PluginCopyKey plugin, string recordType) =>
        reads.GetRecordTypeCounts(plugin)
            .FirstOrDefault(c => string.Equals(c.Type, recordType, StringComparison.OrdinalIgnoreCase))?.Count ?? 0;
}
