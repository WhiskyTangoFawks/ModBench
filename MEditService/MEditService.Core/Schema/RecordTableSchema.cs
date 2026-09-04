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
    /// <summary>The value was converted and written onto the target.</summary>
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
/// neither. With a nullable delegate an accidental omission looked like a decision; here it is
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

/// <summary>One column of a record table: how to read it, write it back, and what a generated view
/// (ADR-0041) may do with it. <see cref="Apply"/> answers an outcome, so a silently lost edit is
/// unrepresentable.</summary>
public sealed record ColumnSpec(
    string Name,
    string PropertyName,
    string DuckDbType,
    Func<IMajorRecordGetter, object?> Extract,
    string ApiType,
    IReadOnlyList<string> ValidFormKeyTypes,
    IReadOnlyList<EnumMember> EnumMembers,
    LeafWrite<IMajorRecord> Apply,
    bool IsArray = false,
    FieldMetadata? ElementType = null,
    IReadOnlyList<FieldMetadata>? SubFields = null,
    bool AllowsNull = false,
    // A scalar widen: sibling subclasses disagree on this field's type, so it is read-only text with
    // no single JSON path, and views omit it. Exactly two in Fallout 4: gmst.data and glob.data.
    bool IsWidened = false,
    // Whether the CLR enum carries [Flags], so the serializer writes a name array views join with ", ".
    // Deliberately not IsBitmask, which is narrower and disagrees on real data (misc.major_flags).
    bool IsFlagsEnum = false,
    // The SQL literal a view COALESCEs to when the serializer omitted a default-valued field, or null
    // when NULL is the honest answer.
    string? ViewDefaultLiteral = null,
    // For a keyed array, the element members whose values identify an element.
    IReadOnlyList<string>? KeyMembers = null,
    string? LeafTypeName = null)
{
    /// <summary>Scalar leaves only: arrays and structs have no faithful scalar rendering, and a widened
    /// column no consistent path. "No column" beats "a column with broken semantics".</summary>
    public bool IsViewable => !IsArray && SubFields == null && !IsWidened;

    /// <summary>See <see cref="FieldMetadata.IsBitmask"/> — the same question off the same members,
    /// so a column and the metadata it projects into cannot answer differently.</summary>
    public bool IsBitmask => EnumMember.IsBitmask(EnumMembers);

    public FieldMetadata ToFieldMetadata() =>
        new(Name, ApiType, IsArray, ValidFormKeyTypes, EnumMembers, ElementType, SubFields,
            AllowsNull: AllowsNull, KeyMembers: KeyMembers, LeafTypeName: LeafTypeName);
}

public sealed class RecordTableSchema
{
    public required string TableName { get; init; }
    public required Type RecordType { get; init; }
    public required IReadOnlyList<ColumnSpec> RecordColumns { get; init; }

    /// <summary>The xEdit display name ("Activator" for <c>acti</c>); <see cref="TableName"/> stays
    /// the key everywhere else.</summary>
    public required string DisplayName { get; init; }

    /// <summary>The header schema's read path, aligned with <see cref="RecordColumns"/>, since a mod
    /// header is never an IMajorRecordGetter; null for every other schema. Non-null is how readers
    /// recognise the header schema, not a table name.</summary>
    public IReadOnlyList<Func<IModGetter, object?>>? HeaderColumnExtract { get; init; }
}
