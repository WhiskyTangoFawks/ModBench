using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>The Compile gesture's handler (ADR-0014): it owns the selection, and every
/// step of the compile itself stays on <see cref="PluginCompileService"/>.</summary>
public sealed class CompilePluginHandler
{
    private readonly PluginCompileService _compileService;
    private readonly LoadOrderHolder _loadOrder;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal CompilePluginHandler(PluginCompileService compileService, LoadOrderHolder loadOrder) =>
        (_compileService, _loadOrder) = (compileService, loadOrder);

    /// <summary>Throws <see cref="NoLoadOrderException"/> with nothing written when none is held: no
    /// plugin of the selection escapes it (commands.md, A selection is one gesture).</summary>
    public async Task<CompileSelectionResult> CompileAsync(IReadOnlyList<PluginAddress> plugins)
    {
        _loadOrder.Require();
        var landed = new List<CompiledPlugin>();
        var refused = new List<CompileRefused>();
        foreach (var plugin in plugins)
        {
            var result = await CompileOneAsync(plugin);
            if (result.Succeeded)
            {
                landed.Add(new CompiledPlugin(plugin, result.Masters, result.Diagnostics));
                continue;
            }

            var reason = result.RefusalReason
                ?? throw new InvalidOperationException("Expected a refused compile to carry the reason it was refused.");
            refused.Add(new CompileRefused(plugin, reason));
        }
        return new CompileSelectionResult(landed, refused);
    }

    private async Task<CompileResult> CompileOneAsync(PluginAddress plugin)
    {
        // The binary lives in a folder Modbench does not own exclusively (ADR-0003), so a write the
        // file system refuses is this plugin's failure, and the rest of the selection still compiles.
        try
        {
            return await _compileService.CompileAsync(plugin);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return CompileResult.Refused(
                $"Could not write {plugin.Name}: {ex.Message} Its source is untouched, so compiling again rebuilds it.");
        }
    }
}
