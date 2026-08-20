namespace MEditService.Core.Edits;

/// <summary>
/// One diagnostic <see cref="PluginCompileService.Compile"/> found while compiling — semantic
/// breakage (a dangling FormLink, an unplaceable stripped-container child) that does not stop the
/// binary from being written. Returned, never side-effected: publishing these to VS Code's Problems
/// panel against the ledger files is the caller's (extension wiring's) job, which is what keeps this
/// module testable through its own seam.
/// </summary>
public sealed record CompileDiagnostic(string FormKey, string LedgerRelativePath, string Message);

/// <summary>
/// The pinned contract's return type (#416 comment 1 on the issue). A refusal
/// (<see cref="Refused"/>) is a typed result naming why, never an exception — reserved for a state
/// that is <b>structurally impossible to emit</b> (a FormKey collision the write pipeline cannot
/// encode without renumbering, or a ledger record with no parent slot anywhere in the plugin's own
/// container structure). Everything else — dangling FormLinks and kin — compiles successfully with
/// <see cref="Diagnostics"/> describing what's wrong.
/// </summary>
public sealed record CompileResult(
    bool Succeeded,
    string? RefusalReason,
    IReadOnlyList<CompileDiagnostic> Diagnostics,
    IReadOnlyList<string> Masters)
{
    public static CompileResult Refused(string reason) => new(false, reason, [], []);

    public static CompileResult Success(IReadOnlyList<CompileDiagnostic> diagnostics, IReadOnlyList<string> masters) =>
        new(true, null, diagnostics, masters);
}
