using System.Text.Json;
using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Core.Schema;

/// <summary>Null when clean. Only the engine-hardcoded-range exemption (ObjectID &lt; $800) is
/// TES5Edit's read (wbImplementation.pas); the resolved/wrong-type/unresolved split is mEdit's own.</summary>
public static class CheckErrorBuilder
{
    // ADR-0005: `resolve` is a lookup the caller already holds — the Index's O(1) form_lookup read
    // on the read side, the load order's link cache at compile — never a scan started here.
    public static string? Build(
        FieldMetadata meta, JsonElement? value, Func<string, RecordLookupEntry?> resolve, GameRelease release)
    {
        var entries = new List<string>();
        FormReferences.Walk(meta, value, "",
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
