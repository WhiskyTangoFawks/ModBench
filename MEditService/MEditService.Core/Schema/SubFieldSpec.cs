using MEditService.Core.Queries;

namespace MEditService.Core.Schema;

internal sealed record SubFieldSpec(
    string Name,
    string ApiType,
    string[] ValidFormKeyTypes,
    IReadOnlyList<EnumMember> EnumMembers,
    IReadOnlyList<SubFieldSpec>? SubFields = null,
    SubFieldSpec? ElementSpec = null,
    bool AllowsNull = false,
    // The row's title when Name is a wire token; see FieldMetadata.DisplayLabel.
    string? DisplayLabel = null,
    // See FieldMetadata.IsDiscriminator.
    bool IsDiscriminator = false,
    // See FieldMetadata.SiblingsInUse.
    IReadOnlyDictionary<string, IReadOnlyList<string>>? SiblingsInUse = null,
    // See FieldMetadata.KeyMembers.
    IReadOnlyList<string>? KeyMembers = null,
    // See FieldMetadata.LeafTypeName.
    string? LeafTypeName = null,
    // See FieldMetadata.Variants.
    IReadOnlyDictionary<string, SubFieldSpec>? Variants = null,
    // See FieldMetadata.Default.
    object? Default = null)
{
    // IsArray is derived from ApiType, as ColumnSpec's is, rather than a flag that could disagree with it.
    public FieldMetadata ToFieldMetadata() =>
        new(Name, ApiType, ApiType == "array", ValidFormKeyTypes, EnumMembers,
            ElementSpec?.ToFieldMetadata(),
            SubFields?.Select(s => s.ToFieldMetadata()).ToList(),
            AllowsNull: AllowsNull,
            DisplayLabel: DisplayLabel,
            IsDiscriminator: IsDiscriminator,
            SiblingsInUse: SiblingsInUse,
            KeyMembers: KeyMembers,
            LeafTypeName: LeafTypeName,
            Variants: Variants?.ToDictionary(v => v.Key, v => v.Value.ToFieldMetadata(), StringComparer.Ordinal),
            Default: Default);
}
