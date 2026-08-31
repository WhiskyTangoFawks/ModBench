using MEditService.Bridge;
using MEditService.Core.Plugins;
using MEditService.Core.Records;

namespace MEditService.Api;

/// <summary>
/// ADR-0001: the runtime half of "the index mirrors file state". Subscribes once, for the
/// life of the process, to <see cref="ExternalChangeWatcher.IndexedBinaryChanged"/> and turns each
/// disk event into the index verb it means — changed bytes into a re-index, a vanished file into
/// <c>Unindex</c>, the file-gone verb.
///
/// <para>It lives in the composition root for the same reason
/// <see cref="ExternalChangeLoadOrderHook"/> does: this is the one place that can see both
/// <see cref="ILoadOrderMirror"/> (Core) and the watcher (Bridge) without either project learning
/// about the other. The Bridge deliberately knows nothing of mirror or DuckDB
/// (<c>BridgeKnowsNothingOfLoadOrdersTests</c>), so it reports what happened to a file and stops
/// there.</para>
///
/// <para><b>Nothing escapes <see cref="Apply"/>, and it says whether it worked.</b> It runs on a
/// <see cref="System.Timers.Timer"/> callback thread with no caller to catch anything, where an
/// escaping exception is a process crash rather than a failed request — and every failure mode here
/// is ordinary rather than exceptional: the load order closed between the settle and this call, a
/// plugin no longer held, a file another tool is still writing. Answering <see langword="false"/>
/// rather than merely logging is what keeps the watcher from concluding the index now matches bytes
/// it never managed to read (see <see cref="ExternalChangeWatcher.IndexedBinaryChanged"/>).</para>
/// </summary>
internal sealed class IndexMirror(ILoadOrderMirror mirror, ILogger logger)
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
                    mirror.ReindexPlugin(key).GetAwaiter().GetResult();
                    break;

                case IndexedBinaryChange.Deleted:
                    mirror.UnindexPlugin(key);
                    break;
            }

            return true;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "Could not mirror the on-disk change to {Plugin} ({Origin}) into the index; it will be retried " +
                "the next time that file settles, and re-checked at the next reconcile",
                change.PluginName, change.Origin);
            return false;
        }
    }
}
