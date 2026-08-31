using MEditService.Bridge;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;

namespace MEditService.Api;

/// <summary>
/// The reconcile-time hash check. Runs once, right after a reconcile completes, for every
/// tracked plugin the load order now holds — the composition root's own job, since it is the one
/// place that can see both <c>ILoadOrderMirror</c> (Core) and <see cref="ExternalChangeWatcher"/>
/// (Bridge) without either of those two projects depending on each other. Also (re-)registers the
/// live watch for the same plugins, so a freshly reconciled load order starts covered by both
/// triggers at once — a copy registered by any reconcile, not only the first, is watched from
/// then on.
///
/// <para>The same pass also collects crash-repair offers — a plugin's own
/// <see cref="ExternalChangeClassifier.Classify"/> verdict routes here instead of into the watcher's
/// queue whenever it is <see cref="ExternalChangeClassification.CrashRecovery"/> (an unanswered
/// <see cref="CompileJournal"/> marker), and a read failure on a tracked plugin's binary — never
/// classified at all, since there are no bytes to hash — is caught directly. Neither reason is a
/// question the external-change dialog can honestly ask (see <see cref="CrashRepairOffer"/>'s doc
/// comment), so both return here instead of through the watcher.</para>
/// </summary>
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
                // ADR-0001: every *other* indexed binary — the game's own Data/ masters
                // included — gets an index-mirror watch instead. Its rows came from this file, so a
                // write by MO2, xEdit, Steam or the user is answered by re-reading it, not by asking
                // the user a question they have no working tree to answer it with. The hash comes
                // from the index itself, so "unchanged" here means the same thing it means at
                // load; a plugin the index holds no hash for (an in-memory copy) is not mirrored,
                // since there is nothing to compare against.
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
                // A tracked plugin's binary that cannot be read at all (deleted, moved, torn)
                // is a repair-worthy state on its own — there is nothing to hash, so this never
                // reaches Classify below, and it is reported rather than merely logged and dropped.
                // No live watch either: nothing to watch a path that isn't there.
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
