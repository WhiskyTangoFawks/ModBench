using MEditService.Api.Endpoints;
using MEditService.Bridge;
using MEditService.Core.Notifications;
using MEditService.Core.Plugins;
using MEditService.Core.Records;

namespace MEditService.Api;

/// <summary>ADR-0014: the plugin watcher's external-change signals become notifications and a
/// validate. The watcher carries only the bare mod folder; origin is resolved here.</summary>
internal sealed class ExternalChangeApplier(
    IndexProjector index, LoadOrderHolder holder, INotificationPublisher notifications, ILogger logger)
{
    /// <summary>A mod's question was queued: publishes it for every plugin and tracked file it
    /// names.</summary>
    internal void ApplyPending(UnansweredExternalChange change)
    {
        var origin = PluginEndpoints.OriginOfExternalChange(holder.Current, change.ModFolder);
        var classification = change.Classification;
        notifications.Publish(new ExternalChangePendingNotification(
            origin, classification.Plugins, classification.TrackedFiles,
            classification.MetaChanged, classification.OldVersion, classification.NewVersion));
    }

    /// <summary>ADR-0015 invariant 4: an OS overflow on the classification watch, the same
    /// overflow-to-validate shape <see cref="SourceChangeApplier"/> has for the Source side.</summary>
    internal void ApplyOverflow(string modFolder, string pluginName)
    {
        var origin = PluginEndpoints.OriginOfExternalChange(holder.Current, modFolder, pluginName);
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
