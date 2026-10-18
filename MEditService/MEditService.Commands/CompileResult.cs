using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>Applied or refusal, per plugin (ADR-0019), never the status of the call.</summary>
public sealed record CompileResult(IReadOnlyList<CompiledPlugin> Applied, IReadOnlyList<CompileRefused> Refused)
    : ISelectionAnswer<CompileRefused>;

/// <summary>A plugin of the selection whose binary was written, with its diagnostics (ADR-0007).</summary>
public sealed record CompiledPlugin(string Name, string Origin, IReadOnlyList<CompileDiagnostic> Diagnostics);

/// <summary>A plugin of the selection that wrote nothing, with the typed refusal and the message naming
/// the way out.</summary>
public sealed record CompileRefused(PluginAddress Item, CompileRefusal Refusal, string Message) : IItemRefused<CompileRefusal>
{
    object IItemRefused<CompileRefusal>.Item => Item;
}
