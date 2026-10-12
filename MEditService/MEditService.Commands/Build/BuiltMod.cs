using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands.Build;

/// <summary>A mod of the selection that built: the plugins that compiled, and each plugin refused, which
/// stays as it was (mods.md, Build, stories 8-9).</summary>
public sealed record BuiltMod(
    IReadOnlyList<ItemLanded<PluginAddress, IReadOnlyList<CompileDiagnostic>>> Compiled,
    IReadOnlyList<ItemRefused<PluginAddress, CompileRefusal>> Refused);
