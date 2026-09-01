using System.Text.Json;
using MEditService.Core.Queries;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>
/// What one write attempt against a single leaf property came to — shared by
/// <see cref="ColumnSpec.Apply"/> (record-level) and <c>SchemaReflector</c>'s own sub-field appliers
/// (a struct member or array element, one level down from a column).
///
/// <para><see cref="PropertyNotFound"/>
/// and <see cref="ValueRejected"/> answer "no" for two different reasons with two different fixes — a
/// caller needs to tell them apart rather than collapsing both into one undifferentiated
/// <c>false</c>, the same reasoning behind <c>RecordEditRefusal.ListElementTypeUnresolved</c>
/// a level up. The two are not merely a top-level-column distinction, either: one level down,
/// inside a sub-field shared by several concrete sibling leaf types that don't all declare it (OMOD's
/// own sparse leaf-union — <c>SchemaReflector.BuildObjectModPropertyLeafFields</c>), <see cref="PropertyNotFound"/>
/// is an <i>expected, silent</i> outcome (see <c>SchemaReflector.ApplySubFields</c>), while
/// <see cref="ValueRejected"/> there still fails the whole struct/array write — the same distinction,
/// with different consequences depending on which layer answers it.</para>
/// </summary>
public enum ApplyOutcome
{
    /// <summary>The value was converted and written onto the target.</summary>
    Applied,

    /// <summary>No property of this name exists on the target's own runtime type.
    ///
    /// <para>Reached directly against a top-level column (<c>RecordFieldWriter.TryApply</c>, in
    /// <c>MEditService.Core.Edits</c> — not referenced from here so this stays a leaf schema type),
    /// this is a real refusal: the record's runtime type genuinely has no such field (e.g. GLOB's
    /// <c>output_char</c> column, declared only on <c>GlobalFloat</c> among the four GLOB
    /// subclasses — real per <c>GetSchemas_Glob_OutputCharColumn_ExclusiveToGlobalFloat_NullOnOtherSubclasses</c>,
    /// not a hypothetical). One level down, inside a sub-field shared across several concrete sibling
    /// leaf types that don't all declare it (OMOD's sparse leaf-union — <c>value</c>, <c>value2</c>,
    /// <c>record</c>, <c>enum_int_value</c>, <c>function_type</c>), the identical outcome is an
    /// expected, silent no-op: the property simply does not apply to <i>this</i> element's concrete
    /// leaf, by design, not a defect — <c>SchemaReflector.ApplySubFields</c> is what tells the two
    /// apart, since only it knows which layer it is answering for.</para>
    /// </summary>
    PropertyNotFound,

    /// <summary>The property exists, but the value could not be turned into what it needs — a
    /// converter that threw or declined (an unrecognised enum member, a non-numeric string, an
    /// unparseable or wrongly-shaped FormKey), a JSON <c>null</c> into a non-nullable column, or (one
    /// level up, for a struct/array column) the whole value not being the JSON shape the field takes
    /// at all. Always a refusal, at every level: a struct/array column with a rejected member never
    /// attaches its partially-built value to the record — the same "nothing written before
    /// <c>SetValue</c>" invariant the outer shape guards hold.</summary>
    ValueRejected,

    /// <summary>
    /// The array <i>is</i> the JSON shape the field takes, but at least one element's own
    /// concrete type is abstract (OMOD <c>properties</c>' <c>AObjectModProperty&lt;T&gt;</c> today)
    /// and could not be determined from that element's own payload
    /// (<c>SchemaReflector.ResolveAbstractListElementType</c>). Its own value, distinct from
    /// <see cref="ValueRejected"/>: inferring it from "a rejection whose value is a genuine JSON
    /// array" is ambiguous — a well-typed element whose own <i>sub-field</i> value is declined
    /// (<c>ApplySubFields</c>' fold, still <see cref="ValueRejected"/>) matches that description
    /// too, and the two need different messages (name a discriminator vs. send a value this field
    /// accepts). Answering the outcome directly, rather than reconstructing it from the value's
    /// shape, is what keeps the two unambiguous.
    /// </summary>
    ListElementTypeUnresolved,

    /// <summary>
    /// #642: the payload names a sub-field the schema knows about (<c>SchemaReflector.SubFieldSpec</c>)
    /// but that carries no write delegate for a reason that is not a discriminator no-op — today, every
    /// nested Loqui struct one level inside another struct/array column
    /// (<c>SchemaReflector.BuildStructSubField</c>'s own <c>Apply: null</c>, general to every such
    /// struct, not specific to abstract unions). Distinct from <see cref="PropertyNotFound"/>'s
    /// sibling-merge no-op and from the two deliberate discriminator fields
    /// (<c>value_type</c>/<c>concrete_type</c>, consumed before the object exists and never meant to be
    /// applied to it) — those two stay a silent skip via <c>SubFieldSpec.TargetingRefuses</c> staying
    /// <c>false</c>; only <c>BuildStructSubField</c>'s own output opts in. Only reached when the payload
    /// actually names the sub-field — one absent from the payload never reaches this outcome, the same
    /// "absence is not targeting" rule <c>SchemaReflector.ApplySubFields</c> already applies to every
    /// other member.
    /// </summary>
    SubFieldReadOnly,
}

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
    /// <para>A complex field (CONTEXT.md: array or struct) is written as one atomic value, so an
    /// applier handed something that is not array-/object-shaped has nothing it could sensibly
    /// write and answers a non-Applied outcome, which <c>RecordFieldWriter.TryApply</c> turns into
    /// a refusal naming the field. Returning an outcome rather than being a fire-and-forget
    /// <c>Action</c> is what makes a silently lost edit unrepresentable: a guard cannot no-op its
    /// way into "applied". See <see cref="ApplyOutcome"/> for why the failure outcomes are
    /// distinct.</para>
    /// </summary>
    Func<IMajorRecord, JsonElement, ApplyOutcome>? Apply,
    bool IsArray = false,
    FieldMetadata? ElementType = null,
    IReadOnlyList<FieldMetadata>? SubFields = null,
    bool AllowsNull = false,
    bool IsBitmask = false,
    IReadOnlyList<string>? EnumBitValues = null,

    // ── View-generation facts ─────────────────────────────────────────────────
    // Three things the generated json_extract views (ADR-0041) need to know that nothing else
    // does. All set mechanically at reflection time from the CLR type — never from a curated list
    // of field names, which is the property the rule turns on.

    /// <summary>
    /// This column is a scalar widen: several concrete subclasses share one GRUP signature
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
    /// Whether a generated view can carry this column at all: scalar leaves only.
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
    /// <see cref="Records.DuckDbRecordIndex.IndexVmad"/> already keys off. Drives
    /// whether the frontend renders a Scripts (VMAD) section at all, rather than relying on
    /// per-record data (a VMAD-capable type with no scripts yet should still show an empty,
    /// addable section; a VMAD-incapable type like CMPO must never show one).
    /// </summary>
    public required bool HasVmad { get; init; }

    /// <summary>
    /// Per-mod column extractors for the synthetic "header" record type only (null for every
    /// other schema). A mod header is never an <see cref="IMajorRecordGetter"/>, so
    /// <see cref="ColumnSpec.Extract"/> is structurally unusable for it — this is the real
    /// extraction path, positionally aligned with <see cref="RecordColumns"/>, invoked against a mod
    /// rather than a record.
    ///
    /// <para>Non-null <b>is</b> how the read path recognises the header schema
    /// (<c>DuckDbRecordIndex.DocumentFromBody</c>) and how the two schema-completeness sweeps skip it
    /// (<c>SchemaReflectorLeafCoverageCompletenessTests</c>): it is the one structural fact
    /// distinguishing a schema whose columns hang off an <see cref="IModGetter"/> from every schema
    /// whose columns hang off an <see cref="IMajorRecordGetter"/>. Prefer it to comparing a table
    /// name — that is a value, this is the actual difference.</para>
    ///
    /// <para>#631: the mod these run against is no longer the live plugin at index time. The header's
    /// document (the whole-mod door's root <c>RecordData.json</c>) is stored in <c>records.body</c>
    /// like every other row's, and these delegates run against the mod that document reads back into
    /// — so a header field is produced by the same delegate whether it came from a plugin binary or
    /// from its own source text, exactly as <see cref="ColumnSpec.Extract"/> is for a record.</para>
    /// </summary>
    public IReadOnlyList<Func<IModGetter, object?>>? HeaderColumnExtract { get; init; }
}
