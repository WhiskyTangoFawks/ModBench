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
        IReadOnlyList<PluginAddress> plugins) =>
        Over(plugins, _compileService.CompileAsync);

    /// <summary>Each plugin a build places, compiled to its path whether or not the load order holds it. No two differ
    /// in case alone. The build has asked <see cref="WhyNoPluginCompiles"/>.</summary>
    internal async Task<(IReadOnlyList<ItemLanded<PluginAddress, IReadOnlyList<CompileDiagnostic>>> Landed, IReadOnlyList<ItemRefused<PluginAddress, CompileRefusal>> Refused)> CompileAsync(
        IReadOnlyList<RegisteredPlugin> placed)
    {
        var byKey = placed.ToDictionary(plugin => plugin.Key, PluginAddress.Comparer);
        return await Each([.. byKey.Keys], plugin => _compileService.CompileAsync(byKey[plugin]));
    }

    /// <summary>The cause no plugin of a selection escapes: no load order held, or git unable to run.</summary>
    internal SelectionRefusal<CompileRefusal>? WhyNoPluginCompiles()
    {
        if (_loadOrder.Held is null) return new(CompileRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);
        return _source.WhyGitCannotRun() is { } gitMissing ? new(CompileRefusal.GitUnavailable, gitMissing.Reason) : null;
    }

    private async Task<SelectionResult<PluginAddress, CompileRefusal, IReadOnlyList<CompileDiagnostic>>> Over(
        IReadOnlyList<PluginAddress> plugins, Func<PluginAddress, Task<CompileResult>> compile)
    {
        if (WhyNoPluginCompiles() is { } none)
            return SelectionResult<PluginAddress, CompileRefusal, IReadOnlyList<CompileDiagnostic>>.WholeSelectionRefused(none.Refusal, none.Message);
        var (landed, refused) = await Each(plugins, compile);
        return SelectionResult<PluginAddress, CompileRefusal, IReadOnlyList<CompileDiagnostic>>.PerItem(landed, refused);
    }

    private static Task<(IReadOnlyList<ItemLanded<PluginAddress, IReadOnlyList<CompileDiagnostic>>> Landed, IReadOnlyList<ItemRefused<PluginAddress, CompileRefusal>> Refused)> Each(
        IReadOnlyList<PluginAddress> plugins, Func<PluginAddress, Task<CompileResult>> compile) =>
        ItemWrite.EachAsync(plugins, PluginAddress.Comparer, async plugin => Answered(await compile(plugin)));

    private static ItemAnswer<CompileRefusal, IReadOnlyList<CompileDiagnostic>> Answered(CompileResult result) =>
        result.Succeeded
            ? ItemAnswer<CompileRefusal, IReadOnlyList<CompileDiagnostic>>.Landed(result.Diagnostics)
            : ItemAnswer<CompileRefusal, IReadOnlyList<CompileDiagnostic>>.Refused(
                result.Refusal,
                result.RefusalReason
                    ?? throw new InvalidOperationException("Expected a refused compile to carry the reason it was refused."));
}
