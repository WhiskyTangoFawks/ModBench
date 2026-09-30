using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>A plugin of the selection whose binary was written: the masters its content needs
/// (ADR-0008), and what the reference check found, which never refuses (ADR-0007 invariant 4).</summary>
public sealed record CompiledPlugin(
    PluginAddress Plugin, IReadOnlyList<string> Masters, IReadOnlyList<CompileDiagnostic> Diagnostics);

/// <summary>A plugin of the selection that wrote nothing, and the message naming the way out.</summary>
public sealed record CompileRefused(PluginAddress Plugin, string Message);

/// <summary>Compile over a selection answers per plugin (ADR-0019 invariant 4): each plugin compiles on
/// its own, so one refused never stops the others.</summary>
public sealed record CompileSelectionResult(IReadOnlyList<CompiledPlugin> Landed, IReadOnlyList<CompileRefused> Refused)
{
    public bool AllApplied => Refused.Count == 0;
}
