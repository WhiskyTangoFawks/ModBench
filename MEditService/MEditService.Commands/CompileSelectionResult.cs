using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>A plugin of the selection whose binary was written: its masters (ADR-0008 invariant 2)
/// and its diagnostics (ADR-0007 invariant 4).</summary>
public sealed record CompiledPlugin(
    PluginAddress Plugin, IReadOnlyList<string> Masters, IReadOnlyList<CompileDiagnostic> Diagnostics);

/// <summary>A plugin of the selection that wrote nothing, and the message naming the way out.</summary>
public sealed record CompileRefused(PluginAddress Plugin, string Message);

/// <summary>Compile over a selection answers per plugin (ADR-0019 invariant 4).</summary>
public sealed record CompileSelectionResult(IReadOnlyList<CompiledPlugin> Landed, IReadOnlyList<CompileRefused> Refused)
{
    public bool AllApplied => Refused.Count == 0;
}
