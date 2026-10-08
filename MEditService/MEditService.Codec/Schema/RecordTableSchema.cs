
using System.Text.Json;
using Mutagen.Bethesda;

namespace MEditService.Codec.Schema;

/// <summary>A member the document never spells: the flag FlagName of the flags member at BackingPath.</summary>
public sealed record SyntheticBit(string BackingPath, string FlagName);

/// <summary>One column of a record table: the member's own spec, plus what a generated view
/// needs. A column refuses writes only by naming ReadOnlyReason; the codec
/// decides the rest.</summary>
public sealed record ColumnSpec(
    FieldMetadata Field,
    // The JSON path from the document root, dotted where the document nests the member (the
    // header's "ModHeader.Author"); the same as Name for every record column.
    string PropertyName,
    string DuckDbType,
    // The SQL literal a view COALESCEs to when the serializer omitted a default-valued field, or null
    // when NULL is the honest answer.
    string? ViewDefaultLiteral = null,
    SyntheticBit? Synthetic = null)
{
    /// <summary>The document's other spellings of this column's value, which the reader takes over
    /// it, so a write clears them.</summary>
    public IReadOnlyList<string> Aliases { get; init; } = [];

    /// <summary>The document's own member name, which is the wire name and the view column name.</summary>
    public string Name => Field.Name;

    /// <summary>The wire's own name for the leaf kind, which decides how a view projects it.</summary>
    public string ApiType => Field.Type;

    /// <summary>Scalar leaves with one DuckDB type only: arrays and structs have no scalar rendering,
    /// a column varying by record class no single type, a synthetic member no document node. "No
    /// column" beats "a column with broken semantics".</summary>
    public bool IsViewable =>
        !Field.IsArray && Field.Fields == null && Synthetic == null
        && (Field.Variants == null || Field.Variants.Values.Select(v => v.Type).Distinct(StringComparer.Ordinal).Count() == 1);

    public FieldMetadata ToFieldMetadata() => Field;
}

public sealed class RecordTableSchema
{
    internal RecordTableSchema()
    {
    }

    public required string TableName { get; init; }
    public required Type RecordType { get; init; }
    public required IReadOnlyList<ColumnSpec> RecordColumns { get; init; }

    /// <summary>The xEdit display name ("Activator" for <c>acti</c>); <see cref="TableName"/> stays
    /// the key everywhere else.</summary>
    internal string DisplayName => RecordDisplayNames.For(TableName);

    /// <summary>True for the plugin header, whose document is the whole mod's root RecordData.json
    /// rather than a major record's, so its columns sit under a nested path and it carries no
    /// record-header flags.</summary>
    public bool IsHeader { get; init; }

    /// <summary>Every column's node in <paramref name="document"/>, null where the document omits it,
    /// checked against what <paramref name="resolve"/> answers. No document holds a header's masters
    /// (ADR-0008), so their column reads null here.</summary>
    public List<FieldValue> FieldsOf(JsonElement document, Func<string, ResolvedFormKey?> resolve, GameRelease release)
    {
        var fields = new List<FieldValue>(RecordColumns.Count);
        foreach (var col in RecordColumns)
        {
            // A synthetic member is the bit it stands for, read off the member the document spells.
            var value = col.Synthetic is { } bit
                ? JsonSerializer.SerializeToElement(SyntheticBits.IsSet(document, bit))
                : DocumentNodes.At(document, col.PropertyName);
            var meta = col.ToFieldMetadata();
            // The check reads the shape this record's own class gives the column; the wire keeps the
            // column's whole metadata, variants included, so the editor can pick the same.
            fields.Add(new FieldValue(meta, value, CheckErrorBuilder.Build(DocumentNodes.VariantFor(meta, document), value, resolve, release)));
        }
        return fields;
    }

    // A ModHeader cannot carry the Partial Form flag.
    public bool IsPartialForm(JsonElement document) => !IsHeader && PartialFormFlag.IsSet(document, RecordType);
}
