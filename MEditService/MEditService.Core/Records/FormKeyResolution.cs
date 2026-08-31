using System.Text.Json.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Implicit;
using Mutagen.Bethesda.Plugins.Meta;

namespace MEditService.Core.Records;

// The three-way distinction CheckErrorBuilder already computes (not found / found, wrong type /
// found, valid type) — reused as a shared signal by FieldDiff and VmadPropertyDiff
// so a resolvable-but-wrong-type reference stays distinguishable from a genuinely dangling one
// (ADR-0031). A resolved-wrong-type reference still gets the Ctrl-hover/hyperlink affordance,
// matching xEdit — only Unresolved withholds it.
//
// [JsonConverter] on the enum itself (not just the global ConfigureHttpJsonOptions converter) is
// what Swashbuckle's schema generator honors — without it the enum round-trips as a string at
// runtime but the OpenAPI schema (and therefore generated api.ts) still describes it as an int,
// same as ConflictThis/ConflictAll.
[JsonConverter(typeof(JsonStringEnumConverter))]
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
    //
    // A lookup miss is not automatically a broken link. `entry` comes from `form_lookup`,
    // which only ever carries records that physically exist in some loaded plugin's data — it can
    // never carry an engine-hardcoded FormID (e.g. Player 00000007), because no plugin's data
    // defines one. xEdit reads this range the same way: FileFormIDtoLoadOrderFormID and
    // RemoveMainRecord (wbImplementation.pas) both gate on ObjectID < $800.
    //
    // The module the FormID belongs to still has to be checked, and deliberately against
    // Implicits.Get(release).BaseMasters rather than a single "the game master" name: BaseMasters
    // is Mutagen's set of implicitly-always-loaded modules for this release (the base game plus its
    // required DLCs), and that is the actual property a lookup miss needs — "this module is always
    // present, so a miss here can never mean the module itself is absent." A DLC's own reserved
    // range benefits from the identical reasoning, so BaseMasters is the right set, not an
    // approximation of a narrower one. A low ObjectID in any other module's space is an ordinary
    // reference and stays checked normally.
    public static FormKeyResolution From(string formKey, RecordLookupEntry? entry, IReadOnlyList<string> validTypes, GameRelease release)
    {
        if (entry is not { } e) return IsHardcoded(formKey, release) ? new FormKeyResolution(FormKeyResolutionState.ResolvedValidType, null, null) : Unresolved;

        var isValidType = validTypes.Count == 0 || validTypes.Contains(e.RecordType, StringComparer.OrdinalIgnoreCase);
        return new FormKeyResolution(
            isValidType ? FormKeyResolutionState.ResolvedValidType : FormKeyResolutionState.ResolvedWrongType,
            e.RecordType,
            e.EditorId);
    }

    // TryFactory, not Factory: a malformed or non-FormKey string (an editor's raw, not-yet-validated
    // input — see ScalarFieldApplierRefusalTests) must still fall through to
    // Unresolved — a parse failure is never itself the hardcoded case.
    private static bool IsHardcoded(string formKey, GameRelease release) =>
        FormKey.TryFactory(formKey, out var parsed)
            && parsed.ID < GameConstants.Get(release).DefaultHighRangeFormID
            && Implicits.Get(release).BaseMasters.Contains(parsed.ModKey);
}
