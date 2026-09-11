namespace MEditService.Core.Edits;

/// <summary>Which state of the source compiles to the binary. <see cref="AtRef"/> reads a git ref
/// without checkout, so the edit branch and its dirt are untouched; the extension names the ref
/// literally, never "pristine" (ADR-0007).</summary>
public abstract record CompileSource
{
    public sealed record WorkingTree : CompileSource;

    public sealed record AtRef(string Ref) : CompileSource;

    private CompileSource()
    {
    }
}
