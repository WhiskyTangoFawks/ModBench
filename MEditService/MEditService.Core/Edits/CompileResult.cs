namespace MEditService.Core.Edits;

/// <summary>Semantic breakage that does not stop the binary being written. Returned, never
/// side-effected: publishing to the Problems panel is the caller's job.</summary>
public sealed record CompileDiagnostic(string FormKey, string SourceRelativePath, string Message);

/// <summary>A refusal is typed, never an exception, and reserved for a state structurally impossible
/// to emit (a FormKey collision, a record with no parent slot); everything else compiles with
/// <see cref="Diagnostics"/>.</summary>
public sealed record CompileResult(
    bool Succeeded,
    string? RefusalReason,
    IReadOnlyList<CompileDiagnostic> Diagnostics,
    IReadOnlyList<string> Masters,
    // A typed marker the frontend turns into its "remove the flag and compile?" prompt. Never set
    // for any other refusal, including the same contradiction on a plugin light by .esl extension.
    bool EslContradiction = false)
{
    public static CompileResult Refused(string reason, bool eslContradiction = false) =>
        new(false, reason, [], [], eslContradiction);

    public static CompileResult Success(IReadOnlyList<CompileDiagnostic> diagnostics, IReadOnlyList<string> masters) =>
        new(true, null, diagnostics, masters);
}
