using MEditService.LoadOrder;
using Microsoft.Extensions.Logging;

namespace MEditService.Watcher;

/// <summary>ADR-0015 invariant 4: an operating-system overflow dropped events, so every copy under
/// the watch is compared by content hash rather than trusted. The Index announces what it
/// re-derives.</summary>
internal sealed class OverflowValidation
{
    private readonly WatcherSinks _sinks;
    private readonly ILogger _logger;

    public OverflowValidation(WatcherSinks sinks, ILogger logger)
    {
        _sinks = sinks;
        _logger = logger;
    }

    public void Validate(IReadOnlyList<PluginAddress> keys)
    {
        foreach (var key in keys)
        {
            try
            {
                _sinks.ValidateWholePlugin(key, "a watch overflow");
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                _logger.LogWarning(ex,
                    "Could not validate {Plugin} after a watch overflow; it will be re-checked at the next reconcile",
                    key.Name);
            }
        }
    }
}
