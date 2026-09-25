using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>The Compile gesture's handler (ADR-0014 invariant 3): it owns the selection, and for each
/// plugin the door every write shares first, then every step of the compile itself stays on
/// <see cref="PluginCompileService"/>.</summary>
public sealed class CompilePluginHandler
{
    private readonly WriteTargets _targets;
    private readonly PluginCompileService _compileService;
    private readonly LoadOrderHolder _loadOrder;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal CompilePluginHandler(WriteTargets targets, PluginCompileService compileService, LoadOrderHolder loadOrder) =>
        (_targets, _compileService, _loadOrder) = (targets, compileService, loadOrder);

    /// <summary>Throws <see cref="NoLoadOrderException"/> with nothing written when none is held: no
    /// plugin of the selection escapes it (commands.md, A selection is one gesture).</summary>
    public async Task<CompileSelectionResult> CompileAsync(IReadOnlyList<PluginAddress> plugins, CompileSource source)
    {
        _loadOrder.Require();
        var landed = new List<CompiledPlugin>();
        var refused = new List<CompileRefused>();
        foreach (var plugin in plugins)
        {
            var result = await CompileOneAsync(plugin, source);
            if (result.Succeeded)
            {
                landed.Add(new CompiledPlugin(plugin, result.Masters, result.Diagnostics));
                continue;
            }

            var reason = result.RefusalReason
                ?? throw new InvalidOperationException("Expected a refused compile to carry the reason it was refused.");
            refused.Add(new CompileRefused(plugin, result.Refusal, reason));
        }
        return new CompileSelectionResult(landed, refused);
    }

    private async Task<CompileResult> CompileOneAsync(PluginAddress plugin, CompileSource source)
    {
        // Only the deferral is the door's to refuse here: an untracked or unknown plugin gets
        // compile's own refusal, which names the source it lacks rather than a Track it cannot run.
        if (_targets.RefuseIfBlocked(plugin, out _, out _) is { Refusal: RecordEditRefusal.ExternalChangeUnanswered } blocked)
            return CompileResult.Refused(blocked);

        // The binary lives in a folder Modbench does not own exclusively (ADR-0003), so a write the
        // file system refuses is this plugin's failure, and the rest of the selection still compiles.
        try
        {
            return await _compileService.CompileAsync(plugin, source);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return CompileResult.Refused(
                $"Could not write {plugin.Name}: {ex.Message} Its source is untouched, so compiling again rebuilds it.");
        }
    }
}
