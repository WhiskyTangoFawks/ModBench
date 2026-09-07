using MEditService.Api.Endpoints;
using MEditService.Bridge;
using MEditService.Core.Notifications;
using MEditService.Core.Plugins;
using MEditService.Core.Records;

namespace MEditService.Api;

/// <summary>ADR-0046: the plugin watcher's external-change signals become notifications and a
/// validate. Origin resolution mirrors <c>GetExternalChangeStatus</c> — the watcher only ever
/// carries the bare (modFolder, pluginName) identity.</summary>
internal sealed class ExternalChangeMirror(ILoadOrderMirror mirror, INotificationPublisher notifications, ILogger logger)
{
    /// <summary>A question was queued: publishes it exactly as <c>GET /plugins/external-changes/status</c>
    /// would report it.</summary>
    internal void ApplyPending(UnansweredExternalChange change)
    {
        var origin = PluginEndpoints.OriginOfExternalChange(mirror.LoadOrder, change.ModFolder, change.PluginName);
        notifications.Publish(new ExternalChangePendingNotification(
            new PluginKey(change.PluginName, origin),
            change.Classification.MetaChanged, change.Classification.OldVersion, change.Classification.NewVersion));
    }

    /// <summary>ADR-0046 invariant 6: an OS overflow on the classification watch, mirroring
    /// <see cref="SourceMirror"/>'s own overflow-to-validate shape for the Source side.</summary>
    internal void ApplyOverflow(string modFolder, string pluginName)
    {
        var origin = PluginEndpoints.OriginOfExternalChange(mirror.LoadOrder, modFolder, pluginName);
        var key = new PluginKey(pluginName, origin);
        try
        {
            foreach (var report in mirror.ValidateIndex(key))
            {
                foreach (var failure in report.Failures)
                    logger.LogWarning("Validating {Plugin} after a watch overflow: {Failure}", pluginName, failure);
                if (report.NeedsRebuild) notifications.Publish(new PluginChangedNotification(key, mirror.Sequence));
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
