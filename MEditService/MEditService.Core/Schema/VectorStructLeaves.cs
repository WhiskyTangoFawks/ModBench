using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>Noggog's small value-vector structs (P2*/P3*), presented as their two or three named
/// scalar components. Loqui does not model them, so they have no sub-schema of their own — the
/// components are read and written by ordinary name-keyed reflection on the struct's own X/Y/Z.</summary>
internal static class VectorStructLeaves
{
    private static readonly string[] VectorComponentNames = ["X", "Y", "Z"];

    // The scalar sub-fields (x/y, or x/y/z for a P3-shaped type) a vector-struct leaf carries,
    // reusing the ordinary SubFieldReflection.GetSubFieldInfo/LeafClassification.ClassifyLeaf machinery for the leaf work (byte/short/
    // ushort/int/float -> LeafClassification.PrimitiveMap) rather than a bespoke leaf builder — X/Y/Z are ordinary
    // public get/set properties on the vector type itself, so a PropertyInfo for one of them, handed
    // to SubFieldReflection.GetSubFieldInfo the same way any other struct member's PropertyInfo is, gets the same
    // Get/Apply a top-level scalar column would. Deliberately not any vector type's own
    // self-referencing Point property (`P3Int16 Point => this`, and the same shape on P2UInt8/
    // P3UInt8/P3UInt16) — walking it here would recurse forever, which is why this is a fixed
    // name list rather than a generic property walk over the vector type. A P2-shaped type has no
    // "Z" — GetProperty returns null for it, silently skipped by the `continue` below, which is what
    // makes this list produce exactly 2 sub-fields for a P2 type and 3 for a P3 type with no
    // count-specific branch anywhere in this file.
    internal static List<SubFieldSpec> BuildVectorComponentSubFields(
        Type vectorType, GameReflection game, int depth, ILogger logger)
    {
        var result = new List<SubFieldSpec>();
        foreach (var name in VectorComponentNames)
        {
            var componentProp = vectorType.GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
            if (componentProp == null) continue;
            if (SubFieldReflection.GetSubFieldInfo(componentProp, game, SubFieldReflection.RootPath, depth + 1, logger) is { } spec)
                result.Add(spec);
        }
        return result;
    }

    // A vector-struct field nested inside another struct (e.g. ObjectBounds.First/Second, a
    // P3Int16; Cell.Grid.Point, a P2Int) — xEdit shows OBND's six components individually
    // (wbDefinitionsCommon.pas: wbOBND — X1/Y1/Z1/X2/Y2/Z2, not one opaque value), so this mirrors
    // StructLeaves.BuildStructSubField's shape rather than treating the vector value as an atomic leaf. Unlike
    // StructLeaves.BuildStructSubField's Loqui classes, this one is a value type — Get/SetValue on the
    // *enclosing* object is the only way to write it, so Apply builds (or copies) the current
    // boxed value, applies each component onto that same box, then writes the box back onto the
    // enclosing property.
    internal static SubFieldSpec? BuildVectorSubField(
        PropertyInfo prop, Type core, string colName,
        GameReflection game, int depth, ILogger logger)
    {
        var components = BuildVectorComponentSubFields(core, game, depth, logger);
        if (components.Count == 0) return null;
        var g = ReflectedTypes.SubGetter(prop);
        var pName = prop.Name;
        return new(colName, "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            obj => { var v = g(obj); return v == null ? null : SubFieldValues.ExtractSubObject(v, components); },
            Apply: LeafWrite.Writable<object>((obj, val) => ApplyVectorJson(obj, val, pName, core, components)),
            SubFields: components,
            LeafTypeName: ReflectedTypes.StructTypeName(core));
    }

    // A vector-struct field at the record's own top level (e.g. IslandData.Min/Max,
    // Placed*.Position/Rotation, MaterialObject.ProjectionVector, ImageSpaceAdapter.RadialBlurCenter)
    // — StructLeaves.BuildStructColumn's twin for Noggog's small value-vector structs (see ReflectedTypes.IsVectorStructType),
    // unlike which there is no separate Getter/Setter split to resolve: `core` here already is the
    // concrete vector struct on both sides, so this can always construct and write one,
    // unconditionally.
    //
    // Making Position reachable here for the *Placed family specifically re-opens a hazard
    // RecordEditService.RefuseIfContainmentField's own doc comment names explicitly — placement's
    // Position is mirrored into the `placement` side table (PlacementWalker) with no write-time
    // re-derivation. That refusal covers this path; see its own doc comment for the guard.
    internal static ColumnInfoResult? BuildVectorColumn(
        PropertyInfo prop, Type core, GameReflection game, ILogger logger)
    {
        var components = BuildVectorComponentSubFields(core, game, 0, logger);
        if (components.Count == 0) return null;

        var subFieldMetas = components.ConvertAll(s => s.ToFieldMetadata());

        object? Extractor(IMajorRecordGetter r)
        {
            var obj = ReflectedTypes.ReadOrNull(r, prop);
            return obj == null ? null
                : JsonSerializer.Serialize(SubFieldValues.ExtractSubObject(obj, components));
        }

        var pName = prop.Name;
        return new("VARCHAR", Extractor, "struct", LeafSpec.NoFormKeyTypes, LeafSpec.NoEnumMembers,
            LeafWrite.Writable<IMajorRecord>((record, json) => ApplyVectorJson(record, json, pName, core, components)),
            SubFieldMetas: subFieldMetas, LeafTypeName: ReflectedTypes.StructTypeName(core));
    }

    /// <summary>The one vector write, shared by the top-level column and the nested sub-field — the
    /// same posture <see cref="StructLeaves.ApplyStructJson"/> takes for Loqui structs and
    /// <see cref="AtomicValueLeaves"/> for a Color. A vector is a value type, so the only way to
    /// write it is to build or copy the current boxed value, apply each component onto that box, and
    /// write the box back onto the enclosing property.</summary>
    private static ApplyOutcome ApplyVectorJson(
        object obj, JsonElement json, string pName, Type core, IReadOnlyList<SubFieldSpec> components)
    {
        if (json.ValueKind != JsonValueKind.Object) return ApplyOutcome.ValueRejected;
        var rp = obj.GetType().GetProperty(pName, BindingFlags.Public | BindingFlags.Instance);
        if (rp == null) return ApplyOutcome.PropertyNotFound;
        var current = rp.GetValue(obj) ?? Activator.CreateInstance(core)!;
        var subOutcome = SubFieldValues.ApplySubFields(current, json, components);
        if (subOutcome != ApplyOutcome.Applied) return subOutcome;
        if (rp.CanWrite) rp.SetValue(obj, current);
        return ApplyOutcome.Applied;
    }
}
