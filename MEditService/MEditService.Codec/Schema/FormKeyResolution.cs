using System.Text.Json.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Meta;

namespace MEditService.Codec.Schema;

// Shared with FieldDiff so a resolvable-but-wrong-type reference stays distinguishable from a
// dangling one (ADR-0005). [JsonConverter] on the enum itself is what Swashbuckle honors; without
// it the OpenAPI schema describes the enum as an int.
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

    // A lookup miss is not always a broken link: form_lookup never carries an engine-hardcoded
    // FormID (Player 00000007), because no plugin defines one. xEdit gates the same way, on
    // ObjectID < $800. Only checked against Implicits.BaseMasters, the modules always present.
    public static FormKeyResolution From(string formKey, ResolvedFormKey? entry, IReadOnlyList<string> validTypes, GameRelease release)
    {
        if (entry is not { } e) return IsHardcoded(formKey, release) ? new FormKeyResolution(FormKeyResolutionState.ResolvedValidType, null, null) : Unresolved;

        var isValidType = validTypes.Count == 0 || validTypes.Contains(e.RecordType, StringComparer.OrdinalIgnoreCase);
        return new FormKeyResolution(
            isValidType ? FormKeyResolutionState.ResolvedValidType : FormKeyResolutionState.ResolvedWrongType,
            e.RecordType,
            e.EditorId);
    }

    // TryFactory, not Factory: a malformed string (an editor's raw input) must fall through to
    // Unresolved; a parse failure is never itself the hardcoded case.
    private static bool IsHardcoded(string formKey, GameRelease release) =>
        FormKey.TryFactory(formKey, out var parsed)
            && parsed.ID < GameConstants.Get(release).DefaultHighRangeFormID
            && Implicits.Get(release).BaseMasters.Contains(parsed.ModKey);
}
