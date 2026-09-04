using MEditService.Bridge;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;

namespace MEditService.Api;

/// <summary>The reconcile-time hash check and watch registration, in the composition root because
/// only it sees both the mirror (Core) and the watcher (Bridge). Crash-recovery and unreadable
/// binaries return as repair offers, never as external-change questions.</summary>
internal static class ExternalChangeLoadOrderHook
{
    internal static IReadOnlyList<CrashRepairOffer> RunAfterReconcile(
        ILoadOrder? loadOrder, IRecordIndex? index, ExternalChangeWatcher watcher, ILogger logger)
    {
        // A watch must never outlive the load order that asked for it, or a plugin the
        // load order does not hold would keep re-indexing itself into it.
        watcher.UnwatchAllIndexed();
        if (loadOrder == null) return [];

        var offers = new List<CrashRepairOffer>();
        foreach (var plugin in loadOrder.Plugins)
        {
            var key = new PluginKey(plugin.Name, plugin.Origin);
            if (ModFolders.TrackedOf(loadOrder, key) is not { } modFolder)
            {
                // ADR-0001: every other indexed binary, the game's Data/ masters included, gets an
                // index-mirror watch: a write by another tool is answered by re-reading it, not by
                // asking the user. No indexed hash, nothing to compare against.
                if (index?.IndexedContentHash(key) is { } contentHash)
                    watcher.WatchIndexed(plugin.Name, plugin.Origin, plugin.Path, contentHash);
                continue;
            }

            byte[] bytes;
            try
            {
                bytes = File.ReadAllBytes(plugin.Path);
            }
            catch (IOException ex)
            {
                // Nothing to hash, so this never reaches Classify: an unreadable tracked binary is
                // reported as a repair offer rather than logged and dropped, and gets no live watch.
                logger.LogWarning(ex, "Could not read {Plugin} for the external-change load-time check", plugin.Name);
                offers.Add(new CrashRepairOffer(plugin.Name, plugin.Origin, CrashRepairReason.MissingOrUnreadableBinary));
                continue;
            }

            switch (ExternalChangeClassifier.Classify(modFolder, plugin.Name, bytes))
            {
                case ExternalChangeClassification.ExternalChange change:
                    if (logger.IsEnabled(LogLevel.Information))
                    {
                        logger.LogInformation("External change detected at load for {Plugin} ({Origin})", plugin.Name, plugin.Origin);
                    }
                    watcher.ReportExternalChange(modFolder, plugin.Name, change);
                    break;
                case ExternalChangeClassification.CrashRecovery:
                    // Never watcher.ReportExternalChange — the two prompts must never both fire
                    // for one event, and this one already routes to the repair offer below instead
                    // of the external-change dialog's queue.
                    if (logger.IsEnabled(LogLevel.Information))
                    {
                        logger.LogInformation("Interrupted compile detected at load for {Plugin} ({Origin})", plugin.Name, plugin.Origin);
                    }
                    offers.Add(new CrashRepairOffer(plugin.Name, plugin.Origin, CrashRepairReason.InterruptedCompile));
                    break;
            }

            watcher.Watch(modFolder, plugin.Name, plugin.Path);
        }

        return offers;
    }
}
