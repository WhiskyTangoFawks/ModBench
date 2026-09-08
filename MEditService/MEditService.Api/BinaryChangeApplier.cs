using MEditService.Bridge;
using MEditService.Core.Notifications;
using MEditService.Core.Plugins;
using MEditService.Core.Records;

namespace MEditService.Api;

/// <summary>ADR-0001's runtime half. Nothing escapes <see cref="Apply"/>, which runs on a timer
/// thread where an exception is a process crash; a false answer keeps the watcher from believing
/// the index matches bytes it never read.</summary>
internal sealed class BinaryChangeApplier(IndexProjector index, INotificationPublisher notifications, ILogger logger)
{
    internal bool Apply(IndexedBinaryEvent change)
    {
        var key = new PluginKey(change.PluginName, change.Origin);
        try
        {
            switch (change.Change)
            {
                case IndexedBinaryChange.Modified:
                    if (logger.IsEnabled(LogLevel.Information))
                    {
                        logger.LogInformation(
                            "{Plugin} ({Origin}) changed on disk; re-indexing it", change.PluginName, change.Origin);
                    }
                    index.ReindexPlugin(key).GetAwaiter().GetResult();
                    break;

                case IndexedBinaryChange.Deleted:
                    index.UnindexPlugin(key);
                    break;
            }

            // ADR-0046: the plugin watcher's own re-index, so the whole plugin changed rather than
            // named rows — the same event Track's own reindex would raise if it went through here.
            notifications.Publish(new PluginChangedNotification(key, index.Sequence));
            return true;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "Could not project the on-disk change to {Plugin} ({Origin}) into the index; it will be retried " +
                "the next time that file settles, and re-checked at the next reconcile",
                change.PluginName, change.Origin);
            return false;
        }
    }

    /// <summary>ADR-0046 invariant 6: an OS overflow on the indexed-binary watch, the same
    /// overflow-to-validate shape <see cref="SourceChangeApplier"/> has for the Source side.</summary>
    internal void ApplyOverflow(string pluginName, string origin)
    {
        var key = new PluginKey(pluginName, origin);
        try
        {
            foreach (var report in index.ValidateIndex(key))
            {
                foreach (var failure in report.Failures)
                    logger.LogWarning("Validating {Plugin} after a watch overflow: {Failure}", pluginName, failure);
                if (report.NeedsRebuild) notifications.Publish(new PluginChangedNotification(key, index.Sequence));
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "Could not validate {Plugin} after a watch overflow; it will be re-checked at the next reconcile",
                pluginName);
        }
    }
}
