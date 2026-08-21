namespace MEditService.Core.Edits;

/// <summary>
/// Which state of a plugin's source <see cref="PluginCompileService.Compile"/> serializes to the
/// binary (#416 pinned contract). <see cref="WorkingTree"/> is the normal Save &amp; Compile gesture;
/// <see cref="AtRef"/> reads the source as a named git ref has it — no checkout, so the edit branch
/// and its dirt are untouched — which is how compiling at <c>main</c> restores the pristine binary
/// (Modified workflow) or rebuilds the release line (Authored workflow) behind one confirmation the
/// extension names by the literal ref, never "pristine" (no stored mode, ADR-0041 amendment).
/// </summary>
public abstract record CompileSource
{
    public sealed record WorkingTree : CompileSource;

    public sealed record AtRef(string Ref) : CompileSource;

    private CompileSource()
    {
    }
}
