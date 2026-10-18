namespace MEditService.Commands.Edits;

/// <summary>Semantic breakage that does not stop the binary being written. Returned, never
/// side-effected: publishing to the Problems panel is the caller's job.</summary>
public sealed record CompileDiagnostic(string FormKey, string SourceRelativePath, string Message);

/// <summary>A refusal is typed, never an exception: a state structurally impossible to emit (a
/// FormKey collision). Everything else compiles with <see cref="Diagnostics"/>.</summary>
internal sealed record PluginCompileOutcome(
    bool Succeeded,
    CompileRefusal Refusal,
    string? RefusalReason,
    IReadOnlyList<CompileDiagnostic> Diagnostics)
{
    public static PluginCompileOutcome Refused(CompileRefusal refusal, string reason) =>
        new(false, refusal, reason, []);

    public static PluginCompileOutcome Success(IReadOnlyList<CompileDiagnostic> diagnostics) =>
        new(true, CompileRefusal.None, null, diagnostics);
}
