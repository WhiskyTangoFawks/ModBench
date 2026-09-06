using MEditService.Core.Queries;

namespace MEditService.Core.Schema;

/// <summary>A member the document never spells: one bit of the flags member at BackingPath.
/// FlagName is the bit's name where that member is an array of names; Aliases are the codec's other
/// spellings of the bits.</summary>
public sealed record SyntheticBit(string BackingPath, long Bit, string? FlagName, IReadOnlyList<string> Aliases);

/// <summary>One column of a record table: the member's own spec, plus the database facts a
/// generated view (ADR-0041) needs on top of it. A column refuses writes only by naming
/// ReadOnlyReason; the codec decides the rest.</summary>
public sealed record ColumnSpec(
    SubFieldSpec Field,
    // The JSON path from the document root, dotted where the document nests the member (the
    // header's "ModHeader.Author"); the same as Name for every record column.
    string PropertyName,
    string DuckDbType,
    // The SQL literal a view COALESCEs to when the serializer omitted a default-valued field, or null
    // when NULL is the honest answer.
    string? ViewDefaultLiteral = null,
    string? ReadOnlyReason = null,
    SyntheticBit? Synthetic = null)
{
    /// <summary>The document's own member name, which is the wire name and the view column name.</summary>
    public string Name => Field.Name;

    /// <summary>The wire's own name for the leaf kind, which decides how a view projects it.</summary>
    public string ApiType => Field.ApiType;

    /// <summary>Scalar leaves with one DuckDB type only: arrays and structs have no scalar rendering,
    /// a column varying by record class no single type, a synthetic member no document node. "No
    /// column" beats "a column with broken semantics".</summary>
    public bool IsViewable =>
        !Field.IsArray && Field.SubFields == null && Synthetic == null
        && (Field.Variants == null || Field.Variants.Values.Select(v => v.ApiType).Distinct(StringComparer.Ordinal).Count() == 1);

    public FieldMetadata ToFieldMetadata() => Field.ToFieldMetadata();
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
