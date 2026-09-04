using MEditService.Core.Queries;

namespace MEditService.Core.Schema;

internal sealed record SubFieldSpec(
    string Name,
    string ApiType,
    string[] ValidFormKeyTypes,
    IReadOnlyList<EnumMember> EnumMembers,
    Func<object, object?> Extract,
    LeafWrite<object> Apply,
    IReadOnlyList<SubFieldSpec>? SubFields = null,
    SubFieldSpec? ElementSpec = null,
    bool AllowsNull = false,
    // #642: distinguishes "this leaf is read-only because it genuinely has no write support" (not
    // writable — opts in here) from "this leaf is read-only by design and always will be" (a
    // discriminator — stays on this record's default). SubFieldValues.ApplySubFields refuses the former when
    // the payload names it and silently skips the latter; confusing the two directions would
    // either refuse every abstract-union/OMOD write (every payload for those shapes names a
    // discriminator) or let #642's own bug back in.
    //
    // The two discriminator fields (ObjectModPropertyLeaves.BuildObjectModValueTypeField's value_type,
    // LoquiUnions.BuildUnionDiscriminatorField's concrete_type) are read-only deliberately — consumed off
    // the raw JSON before the object they'd apply to even exists, and every abstract-union/
    // OMOD-properties payload names one on every write, so SubFieldValues.ApplySubFields must keep skipping them
    // silently regardless of this flag's default. Since #643 wired nested Loqui structs into the
    // shared StructLeaves.ApplyStructJson and #699 nested lists into the shared ListLeaves.ApplyListSubFieldJson, one
    // producer sets this true: StructLeaves.BuildStructSubField, for a nested struct with no resolvable
    // setter or an excluded union with no discriminator (ConditionData). Defaults
    // false so any future read-only-leaf producer stays a silent skip unless it deliberately opts in.
    bool TargetingRefuses = false,
    // The row's title when Name is a wire name — null for an ordinary sub-field, see
    // FieldMetadata's own doc comment. Set only by LoquiUnions.BuildUnionDiscriminatorField.
    string? DisplayLabel = null,
    // Set by the two discriminator fields the TargetingRefuses comment above already names —
    // see FieldMetadata's own doc comment for what it means.
    bool IsDiscriminator = false,
    // See FieldMetadata.SiblingsInUse. Set from the game's annotation table by
    // SubFieldReflection.ProjectSubField, for the enum leaf the table names.
    IReadOnlyDictionary<string, IReadOnlyList<string>>? SiblingsInUse = null,
    // See FieldMetadata.KeyMembers. Set from the game's annotation table by ListLeaves.
    IReadOnlyList<string>? KeyMembers = null,
    // See FieldMetadata.LeafTypeName. Set by every producer of an ApiType of "struct".
    string? LeafTypeName = null)
{
    // Mirrors ColumnSpec.IsArray's own derivation (ColumnReflection.ReflectColumns: `info.ApiType ==
    // "array"`) rather than adding a redundant constructor flag that could disagree with ApiType.
    public FieldMetadata ToFieldMetadata() =>
        new(Name, ApiType, ApiType == "array", ValidFormKeyTypes, EnumMembers,
            ElementSpec?.ToFieldMetadata(),
            SubFields?.Select(s => s.ToFieldMetadata()).ToList(),
            AllowsNull: AllowsNull,
            DisplayLabel: DisplayLabel,
            IsDiscriminator: IsDiscriminator,
            SiblingsInUse: SiblingsInUse,
            KeyMembers: KeyMembers,
            LeafTypeName: LeafTypeName);
}
