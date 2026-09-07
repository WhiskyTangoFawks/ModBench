using MEditService.Bridge;
using MEditService.Core.Notifications;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;

namespace MEditService.Api;

/// <summary>ADR-0046 invariant 4's runtime half: the Source watcher's signals become projections.
/// Nothing here reads or writes a row itself — the mirror's gated doors do.</summary>
internal sealed class SourceMirror(
    ILoadOrderMirror mirror, SourceChangeWatcher watcher, INotificationPublisher notifications, ILogger logger)
{
    /// <summary>The watch set the load order now implies: one watch per tracked copy, and none for a
    /// copy whose mod folder holds no repository.</summary>
    internal void RefreshWatches()
    {
        // A watch must never outlive the load order that asked for it, or a plugin the load order
        // does not hold would keep validating itself into it.
        watcher.UnwatchAll();
        if (mirror.LoadOrder is not { } loadOrder) return;

        foreach (var plugin in loadOrder.Plugins)
        {
            if (ModFolders.TrackedOf(loadOrder, new PluginKey(plugin.Name, plugin.Origin)) is not { } modFolder)
                continue;
            watcher.Watch(modFolder, SourceDocuments.RootIn(modFolder, plugin.Name), plugin.Name, plugin.Origin);
        }
    }

    /// <summary>Track's own start: every loaded copy in the folder being tracked is watched from
    /// before the tree is written, so Track's burst is projected like any other.</summary>
    internal void WatchTracking(string modFolder, string origin)
    {
        if (mirror.LoadOrder is not { } loadOrder) return;

        foreach (var plugin in loadOrder.Plugins.Where(p => p.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase)))
            watcher.Watch(modFolder, SourceDocuments.RootIn(modFolder, plugin.Name), plugin.Name, plugin.Origin);
    }

    internal void Apply(SourceChangeEvent change)
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
                mirror.RefreshKeys(key, formKeys);
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
        foreach (var report in mirror.ValidateIndex(key))
        {
            foreach (var failure in report.Failures)
                logger.LogWarning("Validating {Plugin} after a source change: {Failure}", key.Name, failure);

            // ADR-0046: a re-derived copy has too many rows to name, so the notification names the
            // plugin instead, exactly as the plugin watcher's own re-index does.
            if (report.NeedsRebuild) notifications.Publish(new PluginChangedNotification(key, mirror.Sequence));
        }
    }

    // Null when any path in the batch names no key: an unknown layout, a document that has gone or one
    // that cannot be read is a whole-plugin question, never a guess.
    private static List<string>? FormKeysOf(SourceChangeEvent change)
    {
        var formKeys = new List<string>();
        foreach (var path in change.Paths)
        {
            if (SourceDocuments.CarriesNoRecord(path)) continue;
            if (SourceDocuments.FormKeyDeclaredBy(path, change.ModFolder, change.PluginName) is not { } formKey)
                return null;
            formKeys.Add(formKey);
        }
        return formKeys;
    }
}
