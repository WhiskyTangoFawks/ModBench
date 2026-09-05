using MEditService.Core.Queries;

namespace MEditService.Core.Schema;

/// <summary>A member the document never spells: one bit of the flags member at BackingPath.
/// FlagName is the bit's name where that member is an array of names; Aliases are the codec's other
/// spellings of the bits.</summary>
public sealed record SyntheticBit(string BackingPath, long Bit, string? FlagName, IReadOnlyList<string> Aliases);

/// <summary>One column of a record table: which document member it is and what a generated view
/// (ADR-0041) may do with it. The codec decides what a write may hold; a column refuses writes only
/// by naming ReadOnlyReason.</summary>
public sealed record ColumnSpec(
    // The document's own member name, which is the wire name and the view column name.
    string Name,
    // The JSON path from the document root, dotted where the document nests the member (the
    // header's "ModHeader.Author"); the same as Name for every record column.
    string PropertyName,
    string DuckDbType,
    string ApiType,
    IReadOnlyList<string> ValidFormKeyTypes,
    IReadOnlyList<EnumMember> EnumMembers,
    bool IsArray = false,
    FieldMetadata? ElementType = null,
    IReadOnlyList<FieldMetadata>? SubFields = null,
    bool AllowsNull = false,
    // The SQL literal a view COALESCEs to when the serializer omitted a default-valued field, or null
    // when NULL is the honest answer.
    string? ViewDefaultLiteral = null,
    // For a keyed array, the element members whose values identify an element.
    IReadOnlyList<string>? KeyMembers = null,
    string? LeafTypeName = null,
    // See FieldMetadata.Variants: a column whose shape or presence differs across the record classes
    // sharing this table (gmst.Data, glob.OutputChar), keyed by the record's own MutagenObjectType.
    IReadOnlyDictionary<string, FieldMetadata>? Variants = null,
    bool IsDiscriminator = false,
    string? DisplayLabel = null,
    // See FieldMetadata.Default.
    object? Default = null,
    string? ReadOnlyReason = null,
    SyntheticBit? Synthetic = null)
{
    /// <summary>Scalar leaves with one DuckDB type only: arrays and structs have no scalar rendering,
    /// a column varying by record class no single type, a synthetic member no document node. "No
    /// column" beats "a column with broken semantics".</summary>
    public bool IsViewable =>
        !IsArray && SubFields == null && Synthetic == null
        && (Variants == null || Variants.Values.Select(v => v.Type).Distinct().Count() == 1);

    public FieldMetadata ToFieldMetadata() =>
        new(Name, ApiType, IsArray, ValidFormKeyTypes, EnumMembers, ElementType, SubFields,
            AllowsNull: AllowsNull, KeyMembers: KeyMembers, LeafTypeName: LeafTypeName, Variants: Variants,
            IsDiscriminator: IsDiscriminator, DisplayLabel: DisplayLabel, Default: Default);
}

public sealed class RecordTableSchema
{
    public required string TableName { get; init; }
    public required Type RecordType { get; init; }
    public required IReadOnlyList<ColumnSpec> RecordColumns { get; init; }

    /// <summary>The xEdit display name ("Activator" for <c>acti</c>); <see cref="TableName"/> stays
    /// the key everywhere else.</summary>
    public required string DisplayName { get; init; }

    /// <summary>True for the plugin header, whose document is the whole mod's root RecordData.json
    /// rather than a major record's, so its columns sit under a nested path and it carries no
    /// record-header flags.</summary>
    public bool IsHeader { get; init; }
}
