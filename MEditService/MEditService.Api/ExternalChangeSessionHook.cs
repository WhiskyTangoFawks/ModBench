using MEditService.Bridge;
using MEditService.Core.Ledger;
using MEditService.Core.Records;
using MEditService.Core.Session;

namespace MEditService.Api;

/// <summary>
/// #417 AC4: the load-time hash check. Runs once, right after a session load completes, for every
/// tracked plugin the session now holds — the composition root's own job, since it is the one place
/// that can see both <c>ISessionManager</c> (Core) and <see cref="ExternalChangeWatcher"/> (Bridge)
/// without either of those two projects depending on each other. Also (re-)registers the live watch
/// for the same plugins, so a freshly loaded session starts covered by both triggers at once.
/// </summary>
internal static class ExternalChangeSessionHook
{
    internal static void RunAfterLoad(IGameSession? session, ExternalChangeWatcher watcher, ILogger logger)
    {
        if (session == null) return;

        foreach (var plugin in session.Plugins)
        {
            var key = new PluginKey(plugin.Name, plugin.Origin);
            if (ModFolders.TrackedOf(session, key) is not { } modFolder) continue;

            byte[] bytes;
            try
            {
                bytes = File.ReadAllBytes(plugin.Path);
            }
            catch (IOException ex)
            {
                logger.LogWarning(ex, "Could not read {Plugin} for the external-change load-time check", plugin.Name);
                continue;
            }

            if (ExternalChangeClassifier.Classify(modFolder, plugin.Name, bytes) is ExternalChangeClassification.ExternalChange change)
            {
                logger.LogInformation("External change detected at load for {Plugin} ({Origin})", plugin.Name, plugin.Origin);
                watcher.ReportExternalChange(modFolder, plugin.Name, change);
            }

            watcher.Watch(modFolder, plugin.Name, plugin.Path);
        }
    }
}
