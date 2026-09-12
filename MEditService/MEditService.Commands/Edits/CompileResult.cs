namespace MEditService.Commands.Edits;

/// <summary>Semantic breakage that does not stop the binary being written. Returned, never
/// side-effected: publishing to the Problems panel is the caller's job.</summary>
public sealed record CompileDiagnostic(string FormKey, string SourceRelativePath, string Message);

/// <summary>A refusal is typed, never an exception: a state structurally impossible to emit (a
/// FormKey collision), or the door every write shares (an unanswered external-change question).
/// Everything else compiles with <see cref="Diagnostics"/>.</summary>
public sealed record CompileResult(
    bool Succeeded,
    string? RefusalReason,
    IReadOnlyList<CompileDiagnostic> Diagnostics,
    IReadOnlyList<string> Masters,
    // A typed marker the frontend turns into its "remove the flag and compile?" prompt. Never set
    // for any other refusal, including the same contradiction on a plugin light by .esl extension.
    bool EslContradiction = false,
    // The shared door's refusals carry the kind the record gestures use; compile's own stay None.
    RecordEditRefusal Refusal = RecordEditRefusal.None)
{
    public static CompileResult Refused(string reason, bool eslContradiction = false) =>
        new(false, reason, [], [], eslContradiction);

    public static CompileResult Refused(RecordEditResult refusal) =>
        new(false, refusal.Message, [], [], Refusal: refusal.Refusal);

    public static CompileResult Success(IReadOnlyList<CompileDiagnostic> diagnostics, IReadOnlyList<string> masters) =>
        new(true, null, diagnostics, masters);
}
