using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Schema;

/// <summary>Null when clean. Only the engine-hardcoded-range exemption (ObjectID &lt; $800) is
/// TES5Edit's read (wbImplementation.pas); the resolved/wrong-type/unresolved split is mEdit's own.</summary>
public static class CheckErrorBuilder
{
    // `resolve` is a lookup the caller already holds. `whyUnchecked` answers only for a caller that
    // can lose a target's bytes. `indexed` is false while `resolve` sees part of the set.
    public static string? Build(
        FieldMetadata meta, JsonElement? value, Func<string, ResolvedFormKey?> resolve, GameRelease release,
        bool indexed, Func<string, string?>? whyUnchecked = null, string? missingStringsFile = null)
    {
        var entries = new List<string>();
        if (missingStringsFile is not null && meta.Type == "translatedString" && HoldsNoText(value))
            entries.Add(missingStringsFile);
        // Nothing unread, for a caller whose targets all live in one store it just read.
        Func<string, string?> unread = whyUnchecked ?? (_ => null);
        FormReferences.Walk(meta, value, "",
            (path, raw, allowsNull, validTypes) =>
            {
                var err = CheckScalar(raw, allowsNull, validTypes, resolve, unread, release, indexed);
                if (err != null) entries.Add(path.Length > 0 ? $"{path}: {err}" : err);
            });
        return entries.Count > 0 ? string.Join("; ", entries) : null;
    }

    // Mutagen writes a translated string whose strings file is missing with its target language alone.
    // A node the record does not hold is no such string.
    private static bool HoldsNoText(JsonElement? value) =>
        value is { ValueKind: JsonValueKind.Object } translated
        && !translated.TryGetProperty("Value", out _)
        && !(translated.TryGetProperty("Values", out var values) && values.GetArrayLength() > 0);

    private static string? CheckScalar(
        string? value, bool allowsNull, IReadOnlyList<string> validTypes,
        Func<string, ResolvedFormKey?> resolve, Func<string, string?> whyUnchecked, GameRelease release, bool indexed)
    {
        if (string.IsNullOrEmpty(value) || value == "Null")
            return allowsNull ? null : $"Found a NULL reference, expected: {Signatures(validTypes)}";

        // Asked only of a miss: a key the lookup answers is answered, and the hardcoded-range
        // exemption stands whether or not that master's file could be read.
        var resolution = FormKeyResolution.From(value, resolve(value), validTypes, release);
        return resolution.State switch
        {
            FormKeyResolutionState.Unresolved when !indexed => null,
            FormKeyResolutionState.Unresolved when whyUnchecked(value) is { } why
                => $"[{value}] <Error: {why}>",
            FormKeyResolutionState.Unresolved => $"[{value}] <Error: Could not be resolved>",
            FormKeyResolutionState.ResolvedWrongType
                => $"Found a {RecordTableName.SignatureOf(resolution.RecordType ?? "")} reference, expected: {Signatures(validTypes)}",
            _ => null,
        };
    }

    private static string Signatures(IReadOnlyList<string> tables) =>
        string.Join(", ", tables.Select(RecordTableName.SignatureOf).Order(StringComparer.Ordinal));
}
