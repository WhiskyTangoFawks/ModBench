namespace MEditService.Core.Edits;

/// <summary>
/// One diagnostic <see cref="PluginCompileService.Compile"/> found while compiling — semantic
/// breakage (a dangling FormLink, an unplaceable stripped-container child) that does not stop the
/// binary from being written. Returned, never side-effected: publishing these to VS Code's Problems
/// panel against the source files is the caller's (extension wiring's) job, which is what keeps this
/// module testable through its own seam.
/// </summary>
public sealed record CompileDiagnostic(string FormKey, string SourceRelativePath, string Message);

/// <summary>
/// A refusal
/// (<see cref="Refused"/>) is a typed result naming why, never an exception — reserved for a state
/// that is <b>structurally impossible to emit</b> (a FormKey collision the write pipeline cannot
/// encode without renumbering, or a source record with no parent slot anywhere in the plugin's own
/// container structure). Everything else — dangling FormLinks and kin — compiles successfully with
/// <see cref="Diagnostics"/> describing what's wrong.
/// </summary>
public sealed record CompileResult(
    bool Succeeded,
    string? RefusalReason,
    IReadOnlyList<CompileDiagnostic> Diagnostics,
    IReadOnlyList<string> Masters,
    // #290: true only for the flag-vs-content coherence refusal a removable ESL flag causes — the
    // typed marker the frontend turns into its "remove the flag and compile?" prompt. Never set
    // for any other refusal, including the same contradiction on a plugin light by .esl extension
    // (no flag to remove).
    bool EslContradiction = false)
{
    public static CompileResult Refused(string reason, bool eslContradiction = false) =>
        new(false, reason, [], [], eslContradiction);

    public static CompileResult Success(IReadOnlyList<CompileDiagnostic> diagnostics, IReadOnlyList<string> masters) =>
        new(true, null, diagnostics, masters);
}
