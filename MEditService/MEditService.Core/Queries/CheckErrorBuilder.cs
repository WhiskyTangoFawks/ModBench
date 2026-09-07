using System.Text.Json;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Core.Queries;

/// <summary>Null when clean. Only the engine-hardcoded-range exemption (ObjectID &lt; $800) is
/// TES5Edit's read (wbImplementation.pas); the resolved/wrong-type/unresolved split is mEdit's own.</summary>
public static class CheckErrorBuilder
{
    // ADR-0031: `resolve` is the O(1) form_lookup read, not a per-table scan. absentMeansNull: a
    // stored document omits an unset link, a fact about the record; a write payload omitting one
    // asserts nothing about it.
    public static string? Build(
        FieldMetadata meta, JsonElement? value, Func<string, RecordLookupEntry?> resolve, GameRelease release,
        bool absentMeansNull = true)
    {
        var entries = new List<string>();
        FormReferences.Walk(meta, value, "",
            (path, raw, allowsNull, validTypes) =>
            {
                var err = CheckScalar(raw, allowsNull, validTypes, resolve, release);
                if (err != null) entries.Add(path.Length > 0 ? $"{path}: {err}" : err);
            },
            absentMeansNull);
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
