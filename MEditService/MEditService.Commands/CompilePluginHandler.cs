using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>The Compile gesture's handler (ADR-0014 invariant 3): the door every write shares
/// first, then every step of the compile itself stays on <see cref="PluginCompileService"/>.</summary>
public sealed class CompilePluginHandler
{
    private readonly WriteTargets _targets;
    private readonly PluginCompileService _compileService;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal CompilePluginHandler(WriteTargets targets, PluginCompileService compileService) =>
        (_targets, _compileService) = (targets, compileService);

    public CompileResult Compile(PluginKey plugin, CompileSource source)
    {
        // Only the deferral is the door's to refuse here: an untracked or unknown plugin gets
        // compile's own refusal, which names the source it lacks rather than a Track it cannot run.
        if (_targets.RefuseIfBlocked(plugin, out _, out _) is { Refusal: RecordEditRefusal.ExternalChangeUnanswered } blocked)
            return CompileResult.Refused(blocked);

        return _compileService.Compile(plugin, source);
    }
}
