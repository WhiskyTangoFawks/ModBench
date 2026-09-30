using MEditService.LoadOrder;
using Microsoft.Extensions.Logging;

namespace MEditService.Watcher;

/// <summary>ADR-0015 invariant 4: every plugin under a watch compared by content hash rather than
/// trusted, when an overflow dropped events or the mod's tracked-ness moved. The Index announces
/// what it re-derives.</summary>
internal sealed class WholePluginValidation
{
    private readonly WatcherSinks _sinks;
    private readonly ILogger _logger;

    public WholePluginValidation(WatcherSinks sinks, ILogger logger)
    {
        _sinks = sinks;
        _logger = logger;
    }

    public void Validate(IReadOnlyList<PluginAddress> keys, string reason)
    {
        foreach (var key in keys)
        {
            try
            {
                _sinks.ValidateWholePlugin(key, reason);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                _logger.LogWarning(ex,
                    "Could not validate {Plugin} after {Reason}; it will be re-checked at the next reconcile",
                    key.Name, reason);
            }
        }
    }
}
