using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>A Loqui sub-record as one struct column or one nested member, written as a single atomic
/// value: every member is applied before anything attaches to the record, so a rejected member leaves
/// nothing written.</summary>
internal static class StructLeaves
{
    // Refused up front: a getter type with no resolvable setter, or an abstract setter whose sub-schema
    // exposes no discriminator (an excluded union), can never be written, and ValueRejected would
    // blame the value's shape instead.
    internal static SubFieldSpec? BuildStructSubField(
        PropertyInfo prop, Type core, string colName,
        GameReflection game, Type[] path, int depth, ILogger logger)
    {
        var sub = SubFieldReflection.BuildSubSchema(core, game, logger, path, depth);
        if (sub.Count == 0) return SchemaRefusals.ReportUnclassified<SubFieldSpec>(game, logger, prop, core, "empty nested struct");
        var g = ReflectedTypes.SubGetter(prop);
        var pName = prop.Name;
        var setterType = ReflectedTypes.GetSetterType(core);
        var writable = setterType != null && (!setterType.IsAbstract || HasDiscriminator(sub));
        return new(colName, "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            obj => { var v = g(obj); return v == null ? null : SubFieldValues.ExtractSubObject(v, sub); },
            Apply: writable
                ? LeafWrite.Writable<object>((obj, val) => ApplyStructJson(obj, val, pName, setterType!, sub))
                : LeafWrite.ReadOnly<object>(
                    "nested struct with no usable write door: no resolvable Loqui setter class, or an " +
                    "excluded union whose discriminator can never appear in a payload"),
            SubFields: sub,
            LeafTypeName: ReflectedTypes.LeafTypeName(core),
            // A payload naming an unwritable sub-field must refuse the whole write rather than report
            // success and drop it.
            TargetingRefuses: !writable);
    }

    // A union base resolves its concrete type off the payload's discriminator, refusing when it
    // can't. The existing object is reused only when it is that type; switching leaf constructs
    // fresh. Nothing attaches unless every member applied.
    private static ApplyOutcome ApplyStructJson(
        object target, JsonElement json, string pName, Type setterType, IReadOnlyList<SubFieldSpec> subFields)
    {
        if (json.ValueKind == JsonValueKind.Null) return ApplyAbsentStruct(target, pName);
        if (json.ValueKind != JsonValueKind.Object) return ApplyOutcome.ValueRejected;

        var concreteType = setterType;
        if (IsUnionWritten(setterType, subFields))
        {
            if (LoquiUnions.ResolveUnionConcreteType(setterType, json) is not { } resolved)
                return ApplyOutcome.ValueRejected;
            concreteType = resolved;
        }

        var rp = target.GetType().GetProperty(pName, BindingFlags.Public | BindingFlags.Instance);
        if (rp == null) return ApplyOutcome.PropertyNotFound;
        var existing = rp.GetValue(target);
        // Exactly the named leaf, not merely assignable to it: an AlphaLayer is a BaseLayer, and
        // switching to the base must build a bare one rather than keep the subclass.
        var obj = existing is { } same && same.GetType() == concreteType ? same : Activator.CreateInstance(concreteType)!;
        var subOutcome = SubFieldValues.ApplySubFields(obj, json, subFields);
        if (subOutcome != ApplyOutcome.Applied) return subOutcome;
        if (rp.CanWrite) rp.SetValue(target, obj);
        return ApplyOutcome.Applied;
    }

    // A null payload means "still absent", what Extract answers for a subrecord the record does not
    // carry. Accepted only when the target holds none; a null over a present struct would be a
    // delete gesture no caller asks for.
    private static ApplyOutcome ApplyAbsentStruct(object target, string pName)
    {
        var rp = target.GetType().GetProperty(pName, BindingFlags.Public | BindingFlags.Instance);
        if (rp == null) return ApplyOutcome.PropertyNotFound;
        return ReflectedTypes.ReadOrNull(target, rp) == null ? ApplyOutcome.Applied : ApplyOutcome.ValueRejected;
    }

    // A union base is written by the leaf the payload names: abstract, so nothing else could be built,
    // or concrete with a discriminator (ScriptProperty), where building the base would discard the
    // leaf asked for.
    internal static bool IsUnionWritten(Type setterType, IReadOnlyList<SubFieldSpec>? subFields) =>
        setterType.IsAbstract || HasDiscriminator(subFields);

    private static bool HasDiscriminator(IReadOnlyList<SubFieldSpec>? subFields) =>
        subFields?.Any(f => f.Name == LoquiUnions.UnionTypeDiscriminator) ?? false;

    internal static ColumnInfoResult? BuildStructColumn(
        PropertyInfo prop, Type core, GameReflection game, ILogger logger)
    {
        var subFields = SubFieldReflection.BuildSubSchema(core, game, logger, SubFieldReflection.RootPath);
        if (subFields.Count == 0) return SchemaRefusals.ReportUnclassified<ColumnInfoResult>(game, logger, prop, core, "empty struct");

        var subFieldMetas = subFields.ConvertAll(s => s.ToFieldMetadata());

        object? Extractor(IMajorRecordGetter r)
        {
            var obj = ReflectedTypes.ReadOrNull(r, prop);
            return obj == null ? null
                : JsonSerializer.Serialize(SubFieldValues.ExtractSubObject(obj, subFields));
        }

        var setterType = ReflectedTypes.GetSetterType(core);
        var pName = prop.Name;
        var apply = LeafWrite.ReadOnly<IMajorRecord>(
            "struct column with no resolvable Loqui setter class, so nothing can be constructed to write onto");
        if (setterType != null)
        {
            // Shared with every nested struct sub-field, so the two write paths cannot drift apart.
            apply = LeafWrite.Writable<IMajorRecord>(
                (record, json) => ApplyStructJson(record, json, pName, setterType, subFields));
        }

        return new("VARCHAR", Extractor, "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers, apply,
            SubFieldMetas: subFieldMetas, LeafTypeName: ReflectedTypes.LeafTypeName(core));
    }
}
