using MEditService.Bridge;
using MEditService.Core.Records;
using MEditService.Core.Session;

namespace MEditService.Api;

/// <summary>
/// #587 / ADR-0001: the runtime half of "the index mirrors file state". Subscribes once, for the
/// life of the process, to <see cref="ExternalChangeWatcher.IndexedBinaryChanged"/> and turns each
/// disk event into the index verb it means — changed bytes into a re-index, a vanished file into
/// <c>Unindex</c>, the file-gone verb.
///
/// <para>It lives in the composition root for the same reason
/// <see cref="ExternalChangeSessionHook"/> does: this is the one place that can see both
/// <see cref="ISessionManager"/> (Core) and the watcher (Bridge) without either project learning
/// about the other. The Bridge deliberately knows nothing of sessions or DuckDB
/// (<c>BridgeKnowsNothingOfSessionsTests</c>), so it reports what happened to a file and stops
/// there.</para>
///
/// <para><b>Nothing escapes <see cref="Apply"/>.</b> It runs on a <see cref="System.Timers.Timer"/>
/// callback thread with no caller to catch anything, where an escaping exception is a process
/// crash rather than a failed request — and every failure mode here is ordinary rather than
/// exceptional: the session torn down between the settle and this call, a plugin no longer held, a
/// file another tool is still writing.</para>
/// </summary>
internal sealed class IndexMirror(ISessionManager sessions, ILogger logger)
{
    internal void Apply(IndexedBinaryEvent change)
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
                    sessions.ReindexPlugin(key).GetAwaiter().GetResult();
                    break;

                case IndexedBinaryChange.Deleted:
                    sessions.UnindexPlugin(key);
                    break;
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "Could not mirror the on-disk change to {Plugin} ({Origin}) into the index",
                change.PluginName, change.Origin);
        }
    }
}
