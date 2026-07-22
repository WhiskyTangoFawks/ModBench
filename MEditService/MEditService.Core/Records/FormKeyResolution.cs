namespace MEditService.Core.Records;

// The three-way distinction CheckErrorBuilder already computes (not found / found, wrong type /
// found, valid type) — reused as a shared signal by FieldDiff, VmadPropertyDiff, and PendingChange
// so a resolvable-but-wrong-type reference stays distinguishable from a genuinely dangling one
// (ADR-0031). A resolved-wrong-type reference still gets the Ctrl-hover/hyperlink affordance,
// matching xEdit — only Unresolved withholds it.
public enum FormKeyResolutionState
{
    Unresolved,
    ResolvedWrongType,
    ResolvedValidType,
}

public sealed record FormKeyResolution(FormKeyResolutionState State, string? RecordType, string? EditorId)
{
    public static readonly FormKeyResolution Unresolved = new(FormKeyResolutionState.Unresolved, null, null);

    // validTypes empty = any resolved type is acceptable (mirrors CheckErrorBuilder.CheckScalar's
    // `validTypes.Count > 0 &&` guard).
    public static FormKeyResolution From(RecordLookupEntry? entry, IReadOnlyList<string> validTypes)
    {
        if (entry is not { } e) return Unresolved;

        var isValidType = validTypes.Count == 0 || validTypes.Contains(e.RecordType, StringComparer.OrdinalIgnoreCase);
        return new FormKeyResolution(
            isValidType ? FormKeyResolutionState.ResolvedValidType : FormKeyResolutionState.ResolvedWrongType,
            e.RecordType,
            e.EditorId);
    }
}
