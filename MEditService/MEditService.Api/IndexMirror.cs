using MEditService.Bridge;
using MEditService.Core.Plugins;
using MEditService.Core.Records;

namespace MEditService.Api;

/// <summary>ADR-0001's runtime half. Nothing escapes <see cref="Apply"/>, which runs on a timer
/// thread where an exception is a process crash; a false answer keeps the watcher from believing
/// the index matches bytes it never read.</summary>
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
