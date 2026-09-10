using MEditService.Bridge;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;

namespace MEditService.Api;

/// <summary>The reconcile-time hash check and watch registration, in the composition root because
/// only it sees both the Index (Core) and the watcher (Bridge). Crash-recovery and unreadable
/// binaries return as repair offers, never as external-change questions.</summary>
internal static class ExternalChangeLoadOrderHook
{
    internal static IReadOnlyList<CrashRepairOffer> RunAfterReconcile(
        IndexProjector index, ModFolderWatcher watcher, ILogger logger)
    {
        // A watch must never outlive the load order that asked for it, or a plugin the
        // load order does not hold would keep re-indexing itself into it.
        watcher.UnwatchAllIndexed();
        if (index.LoadOrder is not { } loadOrder) return [];

        var order = LoadOrder.From(loadOrder);
        var offers = new List<CrashRepairOffer>();
        // Grouped by mod folder: the classifier runs once per mod (ADR-0041 amendment), covering
        // every tracked plugin the mod holds in one pass, exactly as the live watcher's settle does.
        var byModFolder = new Dictionary<string, List<(string Name, string Origin, string Path, byte[] Bytes)>>(StringComparer.Ordinal);

        foreach (var plugin in loadOrder.Plugins)
        {
            var key = new PluginKey(plugin.Name, plugin.Origin);
            if (ModFolders.TrackedOf(order, key) is not { } modFolder)
            {
                // ADR-0001: every other indexed binary, the game's Data/ masters included, gets an
                // indexed-binary watch: a write by another tool is answered by re-reading it, not by
                // asking the user. No indexed hash, nothing to compare against.
                if (index.IndexedContentHash(key) is { } contentHash)
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
                // Nothing to hash: an unreadable tracked binary is a repair offer, not classified,
                // and gets no live watch.
                logger.LogWarning(ex, "Could not read {Plugin} for the external-change load-time check", plugin.Name);
                offers.Add(new CrashRepairOffer(plugin.Name, plugin.Origin, CrashRepairReason.MissingOrUnreadableBinary));
                continue;
            }

            if (!byModFolder.TryGetValue(modFolder, out var entries))
                byModFolder[modFolder] = entries = [];
            entries.Add((plugin.Name, plugin.Origin, plugin.Path, bytes));

            watcher.Watch(modFolder, plugin.Name, plugin.Path);
        }

        foreach (var (modFolder, entries) in byModFolder)
        {
            switch (ExternalChangeClassifier.ClassifyMod(modFolder, [.. entries.Select(e => (e.Name, e.Bytes))]))
            {
                case ExternalChangeClassification.ExternalChange change:
                    if (logger.IsEnabled(LogLevel.Information))
                        logger.LogInformation("External change detected at load for {ModFolder}", modFolder);
                    watcher.ReportExternalChange(modFolder, change);
                    break;
                case ExternalChangeClassification.CrashRecovery:
                    // Never watcher.ReportExternalChange — the two prompts must never both fire for
                    // one event, and this one already routes to the repair offer instead.
                    foreach (var entry in entries)
                    {
                        if (logger.IsEnabled(LogLevel.Information))
                            logger.LogInformation("Interrupted compile detected at load for {Plugin} ({Origin})", entry.Name, entry.Origin);
                        offers.Add(new CrashRepairOffer(entry.Name, entry.Origin, CrashRepairReason.InterruptedCompile));
                    }
                    break;
            }
        }

        return offers;
    }
}
