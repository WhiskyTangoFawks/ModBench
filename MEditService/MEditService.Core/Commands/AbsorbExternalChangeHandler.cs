using MEditService.Core.Plugins;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Commands;

/// <summary>Absorb Upstream Update's handler (ADR-0046 invariant 3). Every step stays on
/// <see cref="ExternalChangeAbsorber"/>, unchanged; this handler carries the call and logs a
/// refusal, which nothing did before.</summary>
public sealed class AbsorbExternalChangeHandler
{
    private readonly ILogger<AbsorbExternalChangeHandler> _logger;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal AbsorbExternalChangeHandler(ILogger<AbsorbExternalChangeHandler> logger) => _logger = logger;

    public AbsorbResult Absorb(string modFolder, string pluginName, string pluginPath, LoadOrder loadOrder)
    {
        var result = ExternalChangeAbsorber.Absorb(modFolder, pluginName, pluginPath, loadOrder);
        if (!result.Applied)
            _logger.LogWarning("Refused to absorb {Plugin}: {Reason}", pluginName, result.RefusalReason);
        return result;
    }
}
