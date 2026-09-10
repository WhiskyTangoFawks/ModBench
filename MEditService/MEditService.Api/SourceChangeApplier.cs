using MEditService.Bridge;
using MEditService.Core.Notifications;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;

namespace MEditService.Api;

/// <summary>ADR-0046 invariant 4's runtime half: the Source watcher's signals become projections.
/// The gate arrives separately from the Index because a batch is one write across several of the
/// Index's own gated doors.</summary>
internal sealed class SourceChangeApplier(
    IndexProjector index, IndexWriteGate writeGate, ModFolderWatcher watcher,
    INotificationPublisher notifications, ILogger logger)
{
    /// <summary>The watch set the load order now implies: one watch per tracked copy, and none for a
    /// copy whose mod folder holds no repository.</summary>
    internal void RefreshWatches()
    {
        // A watch must never outlive the load order that asked for it, or a plugin the load order
        // does not hold would keep validating itself into it.
        watcher.UnwatchAll();
        if (index.LoadOrder is not { } loadOrder) return;

        var order = LoadOrder.From(loadOrder);
        foreach (var plugin in loadOrder.Plugins)
        {
            if (ModFolders.TrackedOf(order, new PluginKey(plugin.Name, plugin.Origin)) is not { } modFolder)
                continue;
            watcher.Watch(modFolder, SourceRepository.RootIn(modFolder, plugin.Name), plugin.Name, plugin.Origin);
        }
    }

    /// <summary>Track's own start: every loaded copy in the folder being tracked is watched only
    /// after the tree is written and committed, so Track's burst is projected like any other.</summary>
    internal void WatchTracking(string modFolder, string origin)
    {
        if (index.LoadOrder is not { } loadOrder) return;

        foreach (var plugin in loadOrder.Plugins.Where(p => p.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase)))
            watcher.Watch(modFolder, SourceRepository.RootIn(modFolder, plugin.Name), plugin.Name, plugin.Origin);
    }

    /// <summary>ADR-0046: the watcher hands over every plugin it settled together. Held under one
    /// gate acquisition, so another writer cannot land between two plugins of the same batch.</summary>
    internal void Apply(IReadOnlyList<SourceChangeEvent> batch)
    {
        try
        {
            using var _ = writeGate.Enter();
            // ADR-0046: the batch is one logical write, so it is one sequence advance — a client
            // that awaits once cannot land between two of its plugins.
            using var projection = index.BeginProjection();
            foreach (var change in batch) ApplyOne(change);
        }
        catch (IndexWriteGateTimeoutException ex)
        {
            // ADR-0026: never swallowed. The timer callback has no caller to propagate to, so the
            // whole batch is logged rather than lost; it is re-checked the same way a single
            // plugin's own catch below re-checks its.
            var plugins = string.Join(", ", batch.Select(c => $"{c.PluginName} ({c.Origin})"));
            logger.LogWarning(ex,
                "Could not project the source change batch for {Plugins}; it will be re-checked at the " +
                "next signal and at the next reconcile", plugins);
        }
    }

    private void ApplyOne(SourceChangeEvent change)
    {
        var key = new PluginKey(change.PluginName, change.Origin);
        try
        {
            // MO2, git and the user can delete a repository at any moment, and a mod that has none is
            // untracked rather than broken: there is nothing left to project from.
            if (!SourceRepository.IsTracked(change.ModFolder))
            {
                watcher.Unwatch(change.PluginName, change.Origin);
                return;
            }

            if (change.Scope == SourceChangeScope.Documents && FormKeysOf(change) is { } formKeys)
            {
                index.RefreshKeys(key, formKeys);
                return;
            }

            Validate(key);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "Could not project the source change to {Plugin} ({Origin}); it will be re-checked at the " +
                "next signal and at the next reconcile", change.PluginName, change.Origin);
        }
    }

    // The answer to a ref move, a dropped event and a burst too wide to name keys for: one git
    // listing for the whole copy, where a per-key refresh asks git per record.
    private void Validate(PluginKey key)
    {
        foreach (var report in index.ValidateIndex(key))
        {
            foreach (var failure in report.Failures)
                logger.LogWarning("Validating {Plugin} after a source change: {Failure}", key.Name, failure);

            // ADR-0046: a re-derived copy has too many rows to name, so this names the plugin.
            // Announced rather than published, so its sequence is the one the batch landed on.
            if (report.NeedsRebuild)
                index.Announce(() => notifications.Publish(new PluginChangedNotification(key, index.Sequence)));
        }
    }

    // Null when any path in the batch names no key: an unknown layout, a document that has gone or one
    // that cannot be read is a whole-plugin question, never a guess.
    private static List<string>? FormKeysOf(SourceChangeEvent change)
    {
        var formKeys = new List<string>();
        foreach (var path in change.Paths)
        {
            if (SourceRepository.CarriesNoRecord(path)) continue;
            if (SourceRepository.FormKeyDeclaredBy(path, change.ModFolder, change.PluginName) is not { } formKey)
                return null;
            formKeys.Add(formKey);
        }
        return formKeys;
    }
}
