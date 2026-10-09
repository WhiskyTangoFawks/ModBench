using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Schema;

/// <summary>Null when clean. Only the engine-hardcoded-range exemption (ObjectID &lt; $800) is
/// TES5Edit's read (wbImplementation.pas); the resolved/wrong-type/unresolved split is mEdit's own.</summary>
public static class CheckErrorBuilder
{
    // `resolve` is a lookup the caller already holds, never a scan started here.
    // `whyUnchecked` answers only for a caller that can lose a target's bytes: unread is not broken.
    // `settled` is false while `resolve` sees part of the set: a miss is not yet dangling.
    public static string? Build(
        FieldMetadata meta, JsonElement? value, Func<string, ResolvedFormKey?> resolve, GameRelease release,
        Func<string, string?>? whyUnchecked = null, bool settled = true)
    {
        var entries = new List<string>();
        // Nothing unread, for a caller whose targets all live in one store it just read.
        Func<string, string?> unread = whyUnchecked ?? (_ => null);
        FormReferences.Walk(meta, value, "",
            (path, raw, allowsNull, validTypes) =>
            {
                var err = CheckScalar(raw, allowsNull, validTypes, resolve, unread, release, settled);
                if (err != null) entries.Add(path.Length > 0 ? $"{path}: {err}" : err);
            });
        return entries.Count > 0 ? string.Join("; ", entries) : null;
    }

    private static string? CheckScalar(
        string? value, bool allowsNull, IReadOnlyList<string> validTypes,
        Func<string, ResolvedFormKey?> resolve, Func<string, string?> whyUnchecked, GameRelease release, bool settled)
    {
        if (string.IsNullOrEmpty(value) || value == "Null")
            return allowsNull ? null : $"Found a NULL reference, expected: {Signatures(validTypes)}";

        // Asked only of a miss: a key the lookup answers is answered, and the hardcoded-range
        // exemption stands whether or not that master's file could be read.
        var resolution = FormKeyResolution.From(value, resolve(value), validTypes, release);
        return resolution.State switch
        {
            FormKeyResolutionState.Unresolved when !settled => null,
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
