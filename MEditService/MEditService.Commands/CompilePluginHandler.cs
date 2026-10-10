using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>The Compile gesture's handler (ADR-0014), and Compile's only way in.</summary>
public sealed class CompilePluginHandler
{
    private readonly PluginCompileService _compileService;
    private readonly LoadOrderHolder _loadOrder;
    private readonly ISourceAdapter _source;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal CompilePluginHandler(PluginCompileService compileService, LoadOrderHolder loadOrder, ISourceAdapter source) =>
        (_compileService, _loadOrder, _source) = (compileService, loadOrder, source);

    /// <summary>Refuses with <see cref="CompileRefusal.NoLoadOrder"/>, writing nothing, when none is held: no
    /// plugin of the selection escapes it (commands.md, A selection is one gesture).</summary>
    public Task<SelectionResult<PluginAddress, CompileRefusal, IReadOnlyList<CompileDiagnostic>>> CompileAsync(
        IReadOnlyList<PluginAddress> plugins)
    {
        if (_loadOrder.Held is null)
        {
            return Task.FromResult(SelectionResult<PluginAddress, CompileRefusal, IReadOnlyList<CompileDiagnostic>>.WholeSelectionRefused(
                CompileRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage));
        }

        return ItemWrite.OverAsync(_source, plugins, PluginAddress.Comparer, CompileRefusal.GitUnavailable, CompileOneAsync);
    }

    private async Task<ItemAnswer<CompileRefusal, IReadOnlyList<CompileDiagnostic>>> CompileOneAsync(PluginAddress plugin)
    {
        var result = await _compileService.CompileAsync(plugin);
        return result.Succeeded
            ? ItemAnswer<CompileRefusal, IReadOnlyList<CompileDiagnostic>>.Landed(result.Diagnostics)
            : ItemAnswer<CompileRefusal, IReadOnlyList<CompileDiagnostic>>.Refused(
                result.Refusal,
                result.RefusalReason
                    ?? throw new InvalidOperationException("Expected a refused compile to carry the reason it was refused."));
    }
}
