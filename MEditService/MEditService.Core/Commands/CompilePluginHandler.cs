using MEditService.Core.Edits;
using MEditService.Core.Records;

namespace MEditService.Core.Commands;

/// <summary>The Compile gesture's handler (ADR-0046 invariant 3). Every step of it stays on
/// <see cref="PluginCompileService"/> — this handler only carries the call.</summary>
public sealed class CompilePluginHandler
{
    private readonly PluginCompileService _compileService;

    // Internal because the shared module is, which is why this assembly registers its own handlers
    // (MEditService.Core.Composition) rather than the host naming a type it cannot see.
    internal CompilePluginHandler(PluginCompileService compileService) => _compileService = compileService;

    public CompileResult Compile(PluginKey plugin, CompileSource source) => _compileService.Compile(plugin, source);
}
