using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Core.Queries;

/// <summary>
/// Computes a diagnostic string for FormLink fields read from the record index. Null when the
/// value is clean. The resolved/wrong-type/unresolved three-way split is mEdit's own shape, not an
/// xEdit citation — only the #613 engine-hardcoded-range exemption within it is TES5Edit's read,
/// confirmed at source in wbImplementation.pas's TwbFile.FileFormIDtoLoadOrderFormID and
/// TwbFile.RemoveMainRecord (both gate on ObjectID &lt; $800; neither carries any wrong-record-type
/// logic — that distinction is not theirs to cite).
/// </summary>
public static class CheckErrorBuilder
{
    // ADR-0031: resolve callers pass IRecordReads.Resolve (the O(1) form_lookup read),
    // not FindRecordType's per-table scan — resolve is a raw lookup; the not-found/wrong-type/
    // valid-type distinction is computed uniformly here via FormKeyResolution.From, the same factory
    // FieldDiff/VmadPropertyDiff resolution uses.
    public static string? Build(FieldMetadata meta, object? value, Func<string, RecordLookupEntry?> resolve, GameRelease release)
    {
        var entries = new List<string>();
        FormRefPathBuilder.Walk(meta, value, "",
            (path, raw, allowsNull, validTypes) =>
            {
                var err = CheckScalar(raw, allowsNull, validTypes, resolve, release);
                if (err != null) entries.Add(path.Length > 0 ? $"{path}: {err}" : err);
            });
        return entries.Count > 0 ? string.Join("; ", entries) : null;
    }

    private static string? CheckScalar(
        string? value, bool allowsNull, IReadOnlyList<string> validTypes, Func<string, RecordLookupEntry?> resolve, GameRelease release)
    {
        if (string.IsNullOrEmpty(value) || value == "Null")
            return allowsNull ? null : $"Found a NULL reference, expected: {string.Join(", ", validTypes)}";

        var resolution = FormKeyResolution.From(value, resolve(value), validTypes, release);
        return resolution.State switch
        {
            FormKeyResolutionState.Unresolved => $"[{value}] <Error: Could not be resolved>",
            FormKeyResolutionState.ResolvedWrongType
                => $"Found a {resolution.RecordType} reference, expected: {string.Join(", ", validTypes)}",
            _ => null,
        };
    }
}
