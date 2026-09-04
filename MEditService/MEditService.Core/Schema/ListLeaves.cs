using System.Collections;
using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Core.Schema;

/// <summary>An <c>IReadOnlyList&lt;T&gt;</c> field, as one array column or one nested array member.
/// Written whole, never per element: the replacement list is built and every element converted before
/// it reaches the record. An element belonging to a union has its concrete leaf resolved from that
/// element's own payload, and an element type that resolves to nothing is its own refusal.</summary>
internal static class ListLeaves
{
    // A list nested one level inside a struct (e.g. Destructible.Resistances/Stages) — ColumnReflection.GetColumnInfo
    // handles this shape at the top level (BuildListColumn); this is
    // its SubFieldReflection.GetSubFieldInfo-side twin. Reuses BuildListColumn's own
    // element-type dispatch (form-link / Loqui-struct / vector) and ApplyListJson for writing, and
    // BuildListItems (not SerializeListItems — see that method's own doc comment for why a sub-field's
    // Extract must stay unserialized) for extraction, so a struct's own list member behaves
    // identically to a top-level array column of the same shape.
    private static List<SubFieldSpec>? BuildListElementSubFields(
        Type elementType, bool isLoqui, bool isVector,
        GameReflection game, Type[] path, ILogger logger)
    {
        if (isLoqui) return SubFieldReflection.BuildSubSchema(elementType, game, logger, path);
        if (isVector) return VectorStructLeaves.BuildVectorComponentSubFields(elementType, game, 0, logger);
        return null;
    }

    private static SubFieldSpec? BuildListElementSpec(
        Type elementType, bool isFl, IReadOnlyList<SubFieldSpec>? elemSubFields,
        GameReflection game)
    {
        if (elemSubFields != null)
            return new("", "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, _ => null,
                Apply: LeafWrite.ReadOnly<object>(SchemaRefusals.ElementTemplateReason), SubFields: elemSubFields);
        if (isFl)
        {
            return new("", "formKey", LeafClassification.GetFormLinkValidTypes(elementType, game), LeafSpec.NoEnumMembers,
                _ => null, Apply: LeafWrite.ReadOnly<object>(SchemaRefusals.ElementTemplateReason), AllowsNull: true);
        }

        if (ByteSliceHex.IsByteSlice(elementType))
            return new("", ByteSliceHex.HexApiType, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, _ => null, Apply: LeafWrite.ReadOnly<object>(SchemaRefusals.ElementTemplateReason));
        return LeafClassification.TryMapPrimitive(elementType, out _, out var elemApiType, out _)
            ? new("", elemApiType, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, _ => null, Apply: LeafWrite.ReadOnly<object>(SchemaRefusals.ElementTemplateReason))
            : null;
    }

    internal static SubFieldSpec? BuildListSubField(
        PropertyInfo prop, string colName, Type elementType,
        GameReflection game, Type[] path, ILogger logger)
    {
        var isFl = ReflectedTypes.IsFormLink(elementType);
        var isLoqui = !isFl && ReflectedTypes.IsLoquiInterface(elementType);
        var isVector = !isFl && !isLoqui && ReflectedTypes.IsVectorStructType(elementType);

        var elemSubFields = BuildListElementSubFields(elementType, isLoqui, isVector, game, path, logger);

        // Mirrors SubFieldReflection.BuildElementMeta's own branches, but building a SubFieldSpec directly rather than
        // a FieldMetadata — this method's caller (SubFieldReflection.GetSubFieldInfo) needs the reflection-time shape
        // (ElementSpec.ToFieldMetadata() below is what turns it into wire metadata), and elemSubFields
        // above has already done the Loqui/vector element work, so there is nothing to gain from routing
        // through SubFieldReflection.BuildElementMeta's own FieldMetadata output and converting it back.
        var elementSpec = BuildListElementSpec(elementType, isFl, elemSubFields, game);
        if (elementSpec == null)
            return SchemaRefusals.ReportUnclassified<SubFieldSpec>(game, logger, prop, elementType, "nested list element");

        var g = ReflectedTypes.SubGetter(prop);
        var pName = prop.Name;
        // Unconditionally writable: BuildListElementSpec above returns non-null for exactly the
        // element shapes BuildListElement can build, so past its guard there is no unwritable case
        // left to spell. TargetingRefuses therefore keeps its false default.
        return new(colName, "array", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            obj => g(obj) is IEnumerable list ? BuildListItems(list, elementType, elemSubFields) : null,
            LeafWrite.Writable<object>(
                (obj, json) => ApplyListSubFieldJson(obj, json, pName, isFl, elementType, elemSubFields)),
            ElementSpec: elementSpec);
    }

    // ApplyListJson's own sub-field twin: writes a struct/array-nested list's whole value, same
    // atomic-write and refusal rules (CONTEXT.md's Complex field), operating on `object` (the
    // enclosing struct instance) rather than IMajorRecord.
    private static ApplyOutcome ApplyListSubFieldJson(
        object obj, JsonElement json, string pName,
        bool isFl, Type elemCore, IReadOnlyList<SubFieldSpec>? subFields)
    {
        if (json.ValueKind != JsonValueKind.Array) return ApplyOutcome.ValueRejected;
        var rp = obj.GetType().GetProperty(pName, BindingFlags.Public | BindingFlags.Instance);
        if (rp == null) return ApplyOutcome.PropertyNotFound;

        var listType = rp.PropertyType;
        var newList = Activator.CreateInstance(listType)!;
        var addMethod = listType.GetMethod("Add")!;
        var elemConcreteType = listType.GetGenericArguments()[0];

        foreach (var elem in json.EnumerateArray())
        {
            if (ResolveListElementType(isFl, elemConcreteType, subFields, elem) is not { } concreteType)
                return ApplyOutcome.ListElementTypeUnresolved;

            var item = BuildListElement(elem, isFl, elemCore, concreteType, subFields, out var elementOutcome);
            if (elementOutcome != ApplyOutcome.Applied) return elementOutcome;
            if (item != null) addMethod.Invoke(newList, [item]);
        }

        if (rp.CanWrite) rp.SetValue(obj, newList);
        return ApplyOutcome.Applied;
    }

    // The raw object graph for a list's elements — FormLink elements become their FormKey string,
    // struct/vector elements become the same Dictionary<string, object?> SubFieldValues.ExtractSubObject builds for any
    // other struct, everything else passes through as-is. Deliberately not itself serialized: a
    // top-level array *column* (BuildListColumn) is the one caller that needs a VARCHAR string, and
    // does its own JsonSerializer.Serialize on top of this (SerializeListItems, below). A struct
    // *sub-field* (BuildListSubField) is not that caller — its own Extract composes under the
    // enclosing struct's single JsonSerializer.Serialize (SubFieldValues.ExtractSubObject's own dictionary), the
    // same way a struct or vector sub-field's Extract already returns a raw Dictionary rather than a
    // pre-serialized string. If BuildListSubField returned a pre-serialized string, the enclosing
    // struct's own serialize pass would re-encode it as an
    // escaped JSON *string* value instead of a nested array — a round-trip break (ApplyListSubFieldJson
    // requires JsonValueKind.Array, so submitting back exactly what Extract just served would be
    // refused) and a silent compare-grid diff failure (ConflictClassifier.BuildArrayChildren no-ops
    // on a non-Array JsonElement.Kind) for every struct-nested list
    // (e.g. Destructible.Resistances/Stages, ActivateParents.Parents).
    private static List<object?> BuildListItems(
        IEnumerable items, Type elementType, IReadOnlyList<SubFieldSpec>? subFields)
    {
        var isFl = ReflectedTypes.IsFormLink(elementType);
        var isBlob = ByteSliceHex.IsByteSlice(elementType);
        var result = new List<object?>();
        foreach (var item in items)
        {
            if (isFl) result.Add((item as IFormLinkGetter)?.FormKeyNullable?.ToString());
            else if (subFields != null) result.Add(SubFieldValues.ExtractSubObject(item, subFields));
            else if (isBlob) result.Add(ByteSliceHex.HexText(item));
            else result.Add(item);
        }
        return result;
    }

    // BuildListColumn's own caller shape: a top-level array column's Extract returns a VARCHAR
    // string (the DuckDB column type), unlike a struct sub-field's Extract (see BuildListItems above).
    private static string? SerializeListItems(
        IEnumerable items, Type elementType, IReadOnlyList<SubFieldSpec>? subFields) =>
        JsonSerializer.Serialize(BuildListItems(items, elementType, subFields));

    internal static ColumnInfoResult? BuildListColumn(
        PropertyInfo prop, Type elementType, GameReflection game, ILogger logger)
    {
        var isFl = ReflectedTypes.IsFormLink(elementType);
        var isLoqui = !isFl && ReflectedTypes.IsLoquiInterface(elementType);
        // A list of vector-struct elements (IslandData.Vertices, a list of P3Float, or
        // LocationCoordinate.Coordinates, a list of P2Int16) — same three-cases-share-one-shape
        // pattern as ColumnReflection.GetColumnInfo, SubFieldReflection.GetSubFieldInfo and
        // SubFieldReflection.BuildElementMeta.
        var isVector = !isFl && !isLoqui && ReflectedTypes.IsVectorStructType(elementType);

        var elemSubFields = BuildListElementSubFields(elementType, isLoqui, isVector, game, SubFieldReflection.RootPath, logger);

        var elemMeta = SubFieldReflection.BuildElementMeta(elementType, game, SubFieldReflection.RootPath, logger);
        if (elemMeta == null) return SchemaRefusals.ReportUnclassified<ColumnInfoResult>(game, logger, prop, elementType, "list element");

        object? Extractor(IMajorRecordGetter r)
        {
            try // Stryker disable once Block: per-call accessor lambda stays silent per MEditService CLAUDE.md; SerializeListItems can throw on unusual record types in real game data
            {
                return ReflectedTypes.ReadOrNull(r, prop) is IEnumerable list
                    ? SerializeListItems(list, elementType, elemSubFields)
                    : null;
            }
            catch { return null; }
        }

        var pName = prop.Name;
        // BuildListElementSpec answers for exactly the element shapes BuildListElement can build, so
        // it is the writability question too. A column has to ask it because it got here on the
        // wider classification SubFieldReflection.BuildElementMeta performs; BuildListSubField does not, because
        // its own null-guard on this same call already answered it.
        var apply = BuildListElementSpec(elementType, isFl, elemSubFields, game) != null
            ? LeafWrite.Writable<IMajorRecord>(
                (record, json) => ApplyListJson(record, json, pName, isFl, elementType, elemSubFields))
            : LeafWrite.ReadOnly<IMajorRecord>(SchemaRefusals.UnconvertibleElementListReason);

        return new("VARCHAR", Extractor, "array", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, apply,
            ElementMeta: elemMeta);
    }

    /// <summary>
    /// Replaces an array field's whole value. Answers <see cref="ApplyOutcome.ValueRejected"/>
    /// for anything that is not array-shaped — typically the bare value of a single element.
    /// An array field is written as one
    /// atomic value (CONTEXT.md), so there is no sensible merge to perform here and no way to guess
    /// where a lone element belongs; the caller refuses instead, which is the difference between
    /// "your edit was rejected" and "your edit reported success and vanished".
    ///
    /// <para>The same refusal-not-silent-drop rule extends one level in, to an individual
    /// element, when the list's own element type is abstract (OMOD's <c>AObjectModProperty&lt;T&gt;</c>
    /// today — <see cref="ReflectedTypes.IsListType"/>'s Getter-side element type is never abstract itself, only the
    /// mutable Setter list's own generic argument can be). Which concrete leaf an element is depends
    /// on that element's own data, so it is resolved per element from the payload
    /// (<see cref="ResolveListElementType"/>) rather than assumed once for the whole field.
    /// Unresolvable — no known discriminator scheme for this abstract type, or a discriminator value
    /// this scheme doesn't recognise — answers <see cref="ApplyOutcome.ListElementTypeUnresolved"/>
    /// immediately, before <c>newList</c> is ever attached to <paramref name="record"/>, so a
    /// partially-abstract array can never leave one element applied and the rest silently missing.
    /// Its own outcome value rather than <c>ValueRejected</c> because the fix is different (name a
    /// discriminator, not resend a differently-shaped value) and because the two are not
    /// reliably tellable apart from the value's shape alone — see the next paragraph.</para>
    ///
    /// <para>The same "before <c>newList</c> is ever attached" guarantee also covers a
    /// well-formed element whose own sub-field value was declined (<see cref="SubFieldValues.ApplySubFields"/>'s
    /// <c>ValueRejected</c> fold, as opposed to a sub-field simply not applying to this element's own
    /// concrete leaf, which stays silent) — a struct-array write with one bad member refuses the whole
    /// array rather than landing every other element and dropping the bad one. This is exactly why
    /// <see cref="ApplyOutcome.ListElementTypeUnresolved"/> is its own outcome rather than
    /// inferred from "a rejection, and the value happens to be a genuine JSON array":
    /// since a well-typed element can
    /// also fail this way, that inference would misclassify a declined sub-field value as an
    /// unresolved element type.</para>
    ///
    /// <para>#642: an element that names a sub-field with no write door (since #643 and #699, the
    /// unwritable residue only — condition data; nested Loqui
    /// structs like <c>QuestReferenceAlias.Location</c> write through the shared
    /// <c>StructLeaves.ApplyStructJson</c> instead) answers <see cref="ApplyOutcome.SubFieldReadOnly"/>,
    /// propagated here from <see cref="BuildListElement"/>'s own outcome rather than folded into
    /// <see cref="ApplyOutcome.ValueRejected"/> — <c>RecordFieldWriter.TryApply</c> gives it the
    /// honest not-editable message <see cref="ApplyOutcome.SubFieldReadOnly"/> gets everywhere
    /// else, instead of the generic shape-mismatch text that would be false here (the payload
    /// <i>was</i> the whole array).</para>
    /// </summary>
    private static ApplyOutcome ApplyListJson(
        IMajorRecord record, JsonElement json, string pName,
        bool isFl, Type elemCore, IReadOnlyList<SubFieldSpec>? subFields)
    {
        if (json.ValueKind != JsonValueKind.Array) return ApplyOutcome.ValueRejected;
        var rp = record.GetType()
            .GetProperty(pName, BindingFlags.Public | BindingFlags.Instance)!;

        var listType = rp.PropertyType;
        var newList = Activator.CreateInstance(listType)!;
        var addMethod = listType.GetMethod("Add")!;

        // Derive the concrete element type from the mutable list's own generic argument, not from
        // ReflectedTypes.GetSetterType — which returns the setter *interface* (e.g. IRankPlacement), not the
        // instantiable concrete class (RankPlacement). A FormLink list's own generic argument here
        // is never used (BuildListElement's isFl branch works from elemCore instead), so it is safe
        // to compute unconditionally.
        var elemConcreteType = listType.GetGenericArguments()[0];

        foreach (var elem in json.EnumerateArray())
        {
            if (ResolveListElementType(isFl, elemConcreteType, subFields, elem) is not { } concreteType)
                return ApplyOutcome.ListElementTypeUnresolved;

            var item = BuildListElement(elem, isFl, elemCore, concreteType, subFields, out var elementOutcome);
            if (elementOutcome != ApplyOutcome.Applied) return elementOutcome;
            if (item != null) addMethod.Invoke(newList, [item]);
        }

        rp.SetValue(record, newList);
        return ApplyOutcome.Applied;
    }

    // OMOD's own Properties element has its own discriminator scheme
    // (ObjectModPropertyLeaves.ResolveObjectModPropertyConcreteType, off AObjectModProperty<T>'s generic-closed shape) —
    // checked first and kept as its own case, the same posture ObjectModPropertyLeaves.IsObjectModPropertyBase
    // takes, rather than folded into the general lookup below (OMOD's leaves are not reflectively
    // discoverable off their own generic base the way every other abstract union's are).
    //
    // Every other abstract list-element type (AQuestAlias, ...) resolves generally, off the
    // same concrete_type discriminator LoquiUnions.BuildUnionDiscriminatorField exposes on read. Either
    // way, an abstract-element field with no scheme that resolves — a missing/unrecognized
    // discriminator, or a genuinely unknown shape — falls straight through to null, which
    // ApplyListJson/ApplyListSubFieldJson turn into a refusal rather than a guess or a throw.
    private static Type? ResolveListElementType(
        bool isFl, Type elemConcreteType, IReadOnlyList<SubFieldSpec>? subFields, JsonElement elem)
    {
        if (isFl || !StructLeaves.IsUnionWritten(elemConcreteType, subFields)) return elemConcreteType;
        return elemConcreteType.IsGenericType && elemConcreteType.GetGenericTypeDefinition().Name == "AObjectModProperty`1"
            ? ObjectModPropertyLeaves.ResolveObjectModPropertyConcreteType(elemConcreteType, elem)
            : LoquiUnions.ResolveUnionConcreteType(elemConcreteType, elem);
    }

    /// <summary>One bare-scalar list element, built from its own JSON token — the same
    /// <see cref="LeafClassification.PrimitiveMap"/> converter and the same hex grammar a scalar leaf of that type
    /// already writes, so a list of strings and a string column agree about what a string is. Null
    /// means the token could not be converted, which the caller turns into a refusal of the whole
    /// array rather than an element silently missing from it.
    ///
    /// <para>A byte-slice element is built as the <c>MemorySlice&lt;byte&gt;</c> Mutagen's own
    /// <c>SliceList&lt;byte&gt;.Add</c> takes, not the read side's <c>ReadOnlyMemorySlice</c>. It
    /// carries no length gate, unlike <see cref="ByteSliceHex.MakeHexApplier"/>: replacing the whole list gives
    /// an element no predecessor at its own position whose size it could have established.</para>
    /// </summary>
    private static object? BuildScalarListElement(JsonElement elem, Type elemCore)
    {
        if (ByteSliceHex.IsByteSlice(elemCore))
        {
            if (elem.ValueKind != JsonValueKind.String) return null;
            return ByteSliceHex.TryParseHex(elem.GetString()!, out var bytes) ? new MemorySlice<byte>(bytes) : (object?)null;
        }

        if (!LeafClassification.TryMapPrimitive(elemCore, out _, out _, out var convert)) return null;
        try
        {
            return convert(elem);
        }
        catch (Exception ex) when (LeafWriters.IsDecliningConverterException(ex))
        {
            return null;
        }
    }

    private static object? BuildListElement(
        JsonElement elem, bool isFl, Type elemCore, Type elemConcreteType, IReadOnlyList<SubFieldSpec>? subFields,
        out ApplyOutcome outcome)
    {
        outcome = ApplyOutcome.Applied;
        if (isFl)
        {
            var fkStr = elem.GetString();
            if (fkStr == null || !FormKey.TryFactory(fkStr, out var fk)) return null;
            var flType = typeof(FormLink<>).MakeGenericType(elemCore.GetGenericArguments()[0]);
            return Activator.CreateInstance(flType, fk);
        }

        // elemCore, not elemConcreteType: the mutable list's own generic argument is the element
        // type only for the shapes that construct one (SliceList<byte>'s is `byte`, not the
        // ReadOnlyMemorySlice the read side and this converter both speak).
        if (subFields == null)
        {
            if (BuildScalarListElement(elem, elemCore) is { } scalar) return scalar;
            outcome = ApplyOutcome.ValueRejected;
            return null;
        }

        var elemObj = Activator.CreateInstance(elemConcreteType)!;
        // #642: propagated as the full ApplyOutcome, not folded to a bool — an element's own
        // unwritable sub-field named by the payload answers ApplyOutcome.SubFieldReadOnly
        // distinctly from an ordinary declined value (ValueRejected), so the caller can refuse the
        // whole array write with the honest not-editable message rather than the generic
        // shape-mismatch text every other declined element member still uses.
        outcome = SubFieldValues.ApplySubFields(elemObj, elem, subFields!);
        return elemObj;
    }
}
