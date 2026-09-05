using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Core.Schema;

/// <summary>An <c>IReadOnlyList</c> field as one array column or a nested member, written whole:
/// every element is converted before anything attaches. A union element's concrete leaf comes from
/// its payload; unresolvable is a refusal.</summary>
internal static class ListLeaves
{
    // The members a composite element is built from: a Loqui element's own sub-schema, a vector
    // element's components (the codec spells the element as text, which the write reads back as
    // components). Null for a scalar element.
    private static List<SubFieldSpec>? BuildListElementSubFields(
        Type elementType, bool isLoqui, bool isVector,
        GameReflection game, Type[] path, ILogger logger)
    {
        if (isLoqui) return SubFieldReflection.BuildSubSchema(elementType, game, logger, path);
        if (isVector) return [.. VectorStructLeaves.ElementComponents(elementType, game, logger)];
        return null;
    }

    private static SubFieldSpec? BuildListElementSpec(
        Type elementType, bool isFl, bool isVector, IReadOnlyList<SubFieldSpec>? elemSubFields,
        GameReflection game)
    {
        if (isVector)
            return new("", "vector", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, Apply: LeafWrite.ReadOnly<object>(SchemaRefusals.ElementTemplateReason));
        if (elemSubFields != null)
            return new("", "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
                Apply: LeafWrite.ReadOnly<object>(SchemaRefusals.ElementTemplateReason), SubFields: elemSubFields,
                LeafTypeName: ReflectedTypes.LeafTypeName(elementType));
        if (isFl)
        {
            return new("", "formKey", LeafClassification.GetFormLinkValidTypes(elementType, game), LeafSpec.NoEnumMembers,
                Apply: LeafWrite.ReadOnly<object>(SchemaRefusals.ElementTemplateReason), AllowsNull: true);
        }

        if (ByteSliceHex.IsByteSlice(elementType))
            return new("", ByteSliceHex.HexApiType, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, Apply: LeafWrite.ReadOnly<object>(SchemaRefusals.ElementTemplateReason));
        return LeafClassification.TryMapPrimitive(elementType, out _, out var elemApiType, out _)
            ? new("", elemApiType, LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, Apply: LeafWrite.ReadOnly<object>(SchemaRefusals.ElementTemplateReason))
            : null;
    }

    internal static SubFieldSpec? BuildListSubField(
        PropertyInfo prop, Type elementType,
        GameReflection game, Type[] path, ILogger logger)
    {
        var isFl = ReflectedTypes.IsFormLink(elementType);
        var isLoqui = !isFl && ReflectedTypes.IsLoquiInterface(elementType);
        var isVector = !isFl && !isLoqui && ReflectedTypes.IsVectorStructType(elementType);

        var elemSubFields = BuildListElementSubFields(elementType, isLoqui, isVector, game, path, logger);

        // Builds a SubFieldSpec directly rather than converting BuildElementMeta's FieldMetadata back,
        // since the caller needs the reflection-time shape.
        var elementSpec = BuildListElementSpec(elementType, isFl, isVector, elemSubFields, game);
        if (elementSpec == null)
            return SchemaRefusals.ReportUnclassified<SubFieldSpec>(game, logger, prop, elementType, "nested list element");

        var pName = prop.Name;
        // Unconditionally writable: BuildListElementSpec above returns non-null for exactly the
        // element shapes BuildListElement can build, so past its guard there is no unwritable case
        // left to spell. TargetingRefuses therefore keeps its false default.
        return new(pName, "array", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            LeafWrite.Writable<object>(
                (obj, json) => ApplyListSubFieldJson(obj, json, pName, isFl, isVector, elementType, elemSubFields)),
            ElementSpec: elementSpec,
            KeyMembers: game.Annotations.KeyMembersFor(prop));
    }

    // ApplyListJson's own sub-field twin: writes a struct/array-nested list's whole value, same
    // atomic-write and refusal rules (CONTEXT.md's Complex field), operating on `object` (the
    // enclosing struct instance) rather than IMajorRecord.
    private static ApplyOutcome ApplyListSubFieldJson(
        object obj, JsonElement json, string pName,
        bool isFl, bool isVector, Type elemCore, IReadOnlyList<SubFieldSpec>? subFields)
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

            var item = BuildListElement(elem, isFl, isVector, elemCore, concreteType, subFields, out var elementOutcome);
            if (elementOutcome != ApplyOutcome.Applied) return elementOutcome;
            if (item != null) addMethod.Invoke(newList, [item]);
        }

        if (rp.CanWrite) rp.SetValue(obj, newList);
        return ApplyOutcome.Applied;
    }

    internal static ColumnInfoResult? BuildListColumn(
        PropertyInfo prop, Type elementType, GameReflection game, ILogger logger)
    {
        var isFl = ReflectedTypes.IsFormLink(elementType);
        var isLoqui = !isFl && ReflectedTypes.IsLoquiInterface(elementType);
        // A list of vector-struct elements (IslandData.Vertices, LocationCoordinate.Coordinates).
        var isVector = !isFl && !isLoqui && ReflectedTypes.IsVectorStructType(elementType);

        var elemSubFields = BuildListElementSubFields(elementType, isLoqui, isVector, game, SubFieldReflection.RootPath, logger);

        var elemMeta = SubFieldReflection.BuildElementMeta(elementType, game, SubFieldReflection.RootPath, logger);
        if (elemMeta == null) return SchemaRefusals.ReportUnclassified<ColumnInfoResult>(game, logger, prop, elementType, "list element");

        var pName = prop.Name;
        // BuildListElementSpec answers for exactly the element shapes BuildListElement can build, so it
        // is the writability question too; a column got here on BuildElementMeta's wider classification.
        var apply = BuildListElementSpec(elementType, isFl, isVector, elemSubFields, game) != null
            ? LeafWrite.Writable<IMajorRecord>(
                (record, json) => ApplyListJson(record, json, pName, isFl, isVector, elementType, elemSubFields))
            : LeafWrite.ReadOnly<IMajorRecord>(SchemaRefusals.UnconvertibleElementListReason);

        return new("VARCHAR", "array", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, apply,
            ElementMeta: elemMeta, KeyMembers: game.Annotations.KeyMembersFor(prop));
    }

    // Anything not array-shaped is refused: an array is written as one atomic value. A union
    // element's concrete leaf is resolved per element, and nothing attaches until every element
    // built, so no partial array is ever left.
    private static ApplyOutcome ApplyListJson(
        IMajorRecord record, JsonElement json, string pName,
        bool isFl, bool isVector, Type elemCore, IReadOnlyList<SubFieldSpec>? subFields)
    {
        if (json.ValueKind != JsonValueKind.Array) return ApplyOutcome.ValueRejected;
        var rp = record.GetType()
            .GetProperty(pName, BindingFlags.Public | BindingFlags.Instance)!;

        var listType = rp.PropertyType;
        var newList = Activator.CreateInstance(listType)!;
        var addMethod = listType.GetMethod("Add")!;

        // The concrete element type comes from the mutable list's own generic argument, not
        // GetSetterType, which returns the setter interface rather than the instantiable class.
        var elemConcreteType = listType.GetGenericArguments()[0];

        foreach (var elem in json.EnumerateArray())
        {
            if (ResolveListElementType(isFl, elemConcreteType, subFields, elem) is not { } concreteType)
                return ApplyOutcome.ListElementTypeUnresolved;

            var item = BuildListElement(elem, isFl, isVector, elemCore, concreteType, subFields, out var elementOutcome);
            if (elementOutcome != ApplyOutcome.Applied) return elementOutcome;
            if (item != null) addMethod.Invoke(newList, [item]);
        }

        rp.SetValue(record, newList);
        return ApplyOutcome.Applied;
    }

    // OMOD's Properties element has its own leaf table; every other union resolves off the
    // document's MutagenObjectType through LoquiUnions. No resolving scheme falls through to null,
    // which the callers turn into a refusal rather than a guess.
    private static Type? ResolveListElementType(
        bool isFl, Type elemConcreteType, IReadOnlyList<SubFieldSpec>? subFields, JsonElement elem)
    {
        if (isFl || !StructLeaves.IsUnionWritten(elemConcreteType, subFields)) return elemConcreteType;
        return elemConcreteType.IsGenericType && elemConcreteType.GetGenericTypeDefinition().Name == "AObjectModProperty`1"
            ? ObjectModPropertyLeaves.ResolveObjectModPropertyConcreteType(elemConcreteType, elem)
            : LoquiUnions.ResolveUnionConcreteType(elemConcreteType, elem);
    }

    // The converter and hex grammar a scalar leaf writes, so list and column agree. A byte-slice
    // element has no length gate, unlike a hex column: replacing the whole list gives it no
    // predecessor whose size to keep.
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
        JsonElement elem, bool isFl, bool isVector, Type elemCore, Type elemConcreteType, IReadOnlyList<SubFieldSpec>? subFields,
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

        if (isVector)
        {
            if (VectorStructLeaves.AsComponents(elem) is not { } components)
            {
                outcome = ApplyOutcome.ValueRejected;
                return null;
            }
            elem = components;
        }

        var elemObj = Activator.CreateInstance(elemConcreteType)!;
        // Propagated as the full ApplyOutcome, not a bool, so an unwritable sub-field named by the
        // payload gets the honest not-editable message rather than the shape-mismatch text.
        outcome = SubFieldValues.ApplySubFields(elemObj, elem, subFields!);
        return elemObj;
    }
}
