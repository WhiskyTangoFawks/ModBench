using System.Text.Json;
using MEditService.Core.Queries;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

public sealed record ColumnSpec(
    string Name,
    string PropertyName,
    string DuckDbType,
    Func<IMajorRecordGetter, object?> Extract,
    string ApiType,
    IReadOnlyList<string> ValidFormKeyTypes,
    IReadOnlyList<string> EnumValues,
    /// <summary>
    /// Writes this column's whole value onto a record, or <c>null</c> when the column is read-only.
    ///
    /// <para>#503: returns whether the write happened. A complex field (CONTEXT.md: array or struct)
    /// is written as one atomic value, so an applier handed something that is not array-/object-shaped
    /// has nothing it could sensibly write and answers <c>false</c> — which
    /// <c>RecordFieldWriter.TryApply</c> turns into a refusal naming the field. It used to be an
    /// <c>Action</c> that simply returned, and the write path reported success regardless, so a
    /// per-element payload lost the user's edit silently. A <c>bool</c> here is what makes that
    /// unrepresentable rather than merely fixed: a future guard cannot no-op its way into "applied".</para>
    /// </summary>
    Func<IMajorRecord, JsonElement, bool>? Apply,
    bool IsArray = false,
    FieldMetadata? ElementType = null,
    IReadOnlyList<FieldMetadata>? SubFields = null,
    bool AllowsNull = false,
    bool IsBitmask = false,
    IReadOnlyList<string>? EnumBitValues = null,

    // ── #413 view-generation facts ────────────────────────────────────────────
    // Three things the generated json_extract views (ADR-0041 / D2) need to know that nothing else
    // does. All set mechanically at reflection time from the CLR type — never from a curated list of
    // field names, which is the property D2's rule turns on.

    /// <summary>
    /// This column is the #263 scalar widen: several concrete subclasses share one GRUP signature
    /// and disagree about the field's type, so it became a read-only text column whose Extract
    /// dispatches on the record's runtime type. It has no single JSON path with consistent
    /// semantics — the document holds a number for one sibling and a string for another — so views
    /// omit it entirely rather than emit a column that means different things per row. Exactly two
    /// in Fallout 4: gmst.data and glob.data.
    /// </summary>
    bool IsWidened = false,

    /// <summary>
    /// The underlying CLR enum carries <see cref="FlagsAttribute"/>, so the serializer writes it as
    /// a JSON <i>array of member names</i> rather than a scalar. Deliberately NOT
    /// <see cref="IsBitmask"/>, which means something narrower ("has power-of-two members") and
    /// disagrees on real data: misc.major_flags is not a bitmask by that test yet still serializes
    /// as <c>["0x800"]</c>. Views join the names with ", ".
    /// </summary>
    bool IsFlagsEnum = false,

    /// <summary>
    /// The SQL literal a view COALESCEs this column to when the document omits the property, or null
    /// when NULL is the honest answer. Mutagen's serializer omits any field equal to its default, so
    /// without this a non-nullable field would read NULL through a view where the wide table held
    /// the default value.
    /// </summary>
    string? ViewDefaultLiteral = null)
{
    /// <summary>
    /// Whether a generated view can carry this column at all (D2, as amended): scalar leaves only.
    /// Arrays and structs are omitted because the document's nested shape has no faithful scalar
    /// rendering, and the widened columns because they have no consistent path — in both cases "no
    /// column" beats "a column with broken semantics".
    /// </summary>
    public bool IsViewable => !IsArray && SubFields == null && !IsWidened;

    public FieldMetadata ToFieldMetadata() =>
        new(Name, ApiType, IsArray, ValidFormKeyTypes, EnumValues, ElementType, SubFields,
            AllowsNull: AllowsNull, IsBitmask: IsBitmask, EnumBitValues: EnumBitValues);
}

public sealed class RecordTableSchema
{
    public required string TableName { get; init; }
    public required Type RecordType { get; init; }
    public required IReadOnlyList<ColumnSpec> RecordColumns { get; init; }

    /// <summary>
    /// The xEdit display name for this record type (e.g. "Activator" for <c>acti</c>), sourced
    /// from <see cref="RecordDisplayNames"/>. Additive display-layer field — <see cref="TableName"/>
    /// (the 4-char signature) remains the key used everywhere else (table keys, filtering, API
    /// payloads). Defaults to <see cref="TableName"/> if the table isn't in the lookup.
    /// </summary>
    public required string DisplayName { get; init; }

    /// <summary>
    /// Whether this record type can carry a VMAD (script attachment) subrecord — computed once at
    /// schema-reflection time from Mutagen's own type system
    /// (<c>IHaveVirtualMachineAdapterGetter</c>), the same interface
    /// <see cref="Records.DuckDbRecordIndex.IndexVmad"/> already keys off. Issue #179: drives
    /// whether the frontend renders a Scripts (VMAD) section at all, rather than relying on
    /// per-record data (a VMAD-capable type with no scripts yet should still show an empty,
    /// addable section; a VMAD-incapable type like CMPO must never show one).
    /// </summary>
    public required bool HasVmad { get; init; }

    /// <summary>
    /// Per-plugin column extractors for the synthetic "header" table only (null for every
    /// other schema). A mod header is never an <see cref="IMajorRecordGetter"/>, so
    /// <see cref="ColumnSpec.Extract"/> is structurally unusable for it — this is the real
    /// extraction path, positionally aligned with <see cref="RecordColumns"/>, invoked once per
    /// plugin against the mod itself rather than per-record.
    /// </summary>
    public IReadOnlyList<Func<IModGetter, object?>>? HeaderColumnExtract { get; init; }

    /// <summary>
    /// Per-column write delegates for the synthetic "header" table only (null for every other
    /// schema). The symmetric write counterpart to <see cref="HeaderColumnExtract"/>: because a
    /// mod header is never an <see cref="IMajorRecord"/>, <see cref="ColumnSpec.Apply"/> can't
    /// write it. Positionally aligned with <see cref="RecordColumns"/>; a null element means the
    /// column is read-only (e.g. masters, edited via a dedicated slice).
    /// </summary>
    public IReadOnlyList<Action<IMod, JsonElement>?>? HeaderColumnApply { get; init; }

    /// <summary>
    /// The bit value of the light-master ("ESL") flag within the header's <c>flags</c> bitmask
    /// (e.g. Fallout4 <c>Small</c>, Skyrim <c>LightMaster</c>). Null when the flags column or a
    /// recognised light-master member is absent. Used for ESL-eligibility validation.
    /// </summary>
    public long? EslFlagValue { get; init; }
}
