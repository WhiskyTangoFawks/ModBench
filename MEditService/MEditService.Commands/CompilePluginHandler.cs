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
    public async Task<SelectionResult<PluginAddress, CompileRefusal, IReadOnlyList<CompileDiagnostic>>> CompileAsync(
        IReadOnlyList<PluginAddress> plugins)
    {
        _loadOrder.Require();
        var landed = new List<ItemLanded<PluginAddress, IReadOnlyList<CompileDiagnostic>>>();
        var refused = new List<ItemRefused<PluginAddress, CompileRefusal>>();
        foreach (var plugin in plugins.Distinct(PluginAddress.Comparer))
        {
            var result = await CompileOneAsync(plugin);
            if (result.Succeeded) landed.Add(new(plugin, result.Diagnostics));
            else refused.Add(new(plugin, result.Refusal, result.RefusalReason
                ?? throw new InvalidOperationException("Expected a refused compile to carry the reason it was refused.")));
        }
        return SelectionResult<PluginAddress, CompileRefusal, IReadOnlyList<CompileDiagnostic>>.PerItem(landed, refused);
    }

    private async Task<CompileResult> CompileOneAsync(PluginAddress plugin)
    {
        // A write the file system refuses (ADR-0003) is this plugin's refusal alone.
        try
        {
            return await _compileService.CompileAsync(plugin);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return CompileResult.Refused(
                CompileRefusal.WriteFailed,
                $"Could not write {plugin.Name}: {ex.Message} Its source is untouched, so compiling again rebuilds it.");
        }
    }
}
