
namespace MEditService.Codec.Schema;

/// <summary>One member of the document, whatever the walk reached it as: a record's own column
/// (<see cref="ColumnSpec.Field"/>), a member nested inside a struct, or an array's element.</summary>
public sealed record SubFieldSpec(
    string Name,
    string ApiType,
    IReadOnlyList<string> ValidFormKeyTypes,
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
    object? Default = null,
    // See FieldMetadata.ReadOnlyReason.
    string? ReadOnlyReason = null,
    // See FieldMetadata.IsRecordHeaderMember.
    bool IsRecordHeaderMember = false)
{
    /// <summary>Derived from ApiType rather than carried, so the two can never disagree.</summary>
    public bool IsArray => ApiType == "array";

    /// <summary>A read-only member has no writable members of its own, so its reason reaches every
    /// member below it.</summary>
    public FieldMetadata ToFieldMetadata(string? inheritedReason = null)
    {
        var reason = ReadOnlyReason ?? inheritedReason;
        return new(Name, ApiType, IsArray, ValidFormKeyTypes, EnumMembers,
            ElementSpec?.ToFieldMetadata(reason),
            SubFields?.Select(s => s.ToFieldMetadata(reason)).ToList(),
            AllowsNull: AllowsNull,
            DisplayLabel: DisplayLabel,
            IsDiscriminator: IsDiscriminator,
            SiblingsInUse: SiblingsInUse,
            KeyMembers: KeyMembers,
            LeafTypeName: LeafTypeName,
            Variants: Variants?.ToDictionary(v => v.Key, v => v.Value.ToFieldMetadata(reason), StringComparer.Ordinal),
            Default: Default,
            ReadOnlyReason: reason,
            IsRecordHeaderMember: IsRecordHeaderMember);
    }
}
