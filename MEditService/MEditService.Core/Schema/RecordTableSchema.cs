using System.Text.Json;
using MEditService.Core.Queries;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>What one write against a single leaf came to. <c>PropertyNotFound</c> and
/// <see cref="ValueRejected"/> answer "no" with different fixes; nested, the former is a no-op
/// while the latter fails the struct/array write.</summary>
public enum ApplyOutcome
{
    Applied,

    /// <summary>No property of this name on the target's runtime type: a real refusal for a column
    /// (GLOB's <c>output_char</c> exists only on GlobalFloat), an expected silent no-op inside a
    /// sparse sibling-leaf union.</summary>
    PropertyNotFound,

    /// <summary>The property exists but the value was declined: a converter that threw, a JSON null
    /// into a non-nullable column, or the wrong shape for a struct/array. Always a refusal; nothing
    /// partial is attached.</summary>
    ValueRejected,

    /// <summary>The array is the right shape, but a union element has no resolvable leaf. Its own
    /// value rather than <see cref="ValueRejected"/> because the fix differs (name a discriminator)
    /// and a declined sub-field value looks the same.</summary>
    ListElementTypeUnresolved,

    /// <summary>The payload names a known sub-field that carries no writer for a reason other than
    /// being a discriminator (<c>SubFieldSpec.TargetingRefuses</c> decides which). Reached only when
    /// the payload names it; absence is never targeting.</summary>
    SubFieldReadOnly,
}

/// <summary>A leaf's write capability: a writer, or a named reason for being read-only, never
/// neither. A nullable delegate would let an accidental omission pass as a decision; here it is
/// unrepresentable.</summary>
public sealed record LeafWrite<TTarget>
{
    /// <summary>Internal so the non-generic <see cref="LeafWrite"/> factories can reach it (CA1000);
    /// it validates the choice anyway.</summary>
    internal LeafWrite(Func<TTarget, JsonElement, ApplyOutcome>? writer, string? readOnlyReason)
    {
        if (writer is null == (readOnlyReason is null))
        {
            throw new ArgumentException(
                "A leaf is either writable or read-only with a named reason — never both, never neither.");
        }

        Writer = writer;
        ReadOnlyReason = readOnlyReason;
    }

    /// <summary>The write, or null exactly when <see cref="ReadOnlyReason"/> is set.</summary>
    public Func<TTarget, JsonElement, ApplyOutcome>? Writer { get; }

    /// <summary>Why this leaf cannot be written, or null exactly when <see cref="Writer"/> is set.
    /// Never empty — a read-only leaf that cannot say why is what this type forbids.</summary>
    public string? ReadOnlyReason { get; }

}

/// <summary>The two ways to make a <see cref="LeafWrite{TTarget}"/>. Non-generic so the factories are
/// ordinary static methods rather than static members on a generic type (CA1000).</summary>
public static class LeafWrite
{
    public static LeafWrite<TTarget> Writable<TTarget>(Func<TTarget, JsonElement, ApplyOutcome> writer) =>
        new(writer, null);

    /// <summary><paramref name="reason"/> is required and must say something: a read-only leaf that
    /// cannot explain itself is exactly what this type exists to forbid.</summary>
    public static LeafWrite<TTarget> ReadOnly<TTarget>(string reason) =>
        string.IsNullOrWhiteSpace(reason)
            ? throw new ArgumentException("A read-only leaf must name its reason.", nameof(reason))
            : new(null, reason);
}

/// <summary>One column of a record table: which document member it is, how it writes back, and
/// what a generated view (ADR-0041) may do with it. Apply answers an outcome, so a silently lost
/// edit is unrepresentable.</summary>
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
    LeafWrite<IMajorRecord> Apply,
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
    // See FieldMetadata.Variants: a column whose shape differs across the record classes sharing
    // this table (gmst.Data, dmgt.DamageTypes), keyed by the record's own MutagenObjectType.
    IReadOnlyDictionary<string, FieldMetadata>? Variants = null,
    bool IsDiscriminator = false,
    string? DisplayLabel = null)
{
    /// <summary>Scalar leaves only: arrays and structs have no faithful scalar rendering, and a
    /// column whose type varies by record class no single DuckDB type. "No column" beats "a column
    /// with broken semantics".</summary>
    public bool IsViewable => !IsArray && SubFields == null && Variants == null;

    public FieldMetadata ToFieldMetadata() =>
        new(Name, ApiType, IsArray, ValidFormKeyTypes, EnumMembers, ElementType, SubFields,
            AllowsNull: AllowsNull, KeyMembers: KeyMembers, LeafTypeName: LeafTypeName, Variants: Variants,
            IsDiscriminator: IsDiscriminator, DisplayLabel: DisplayLabel);
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
