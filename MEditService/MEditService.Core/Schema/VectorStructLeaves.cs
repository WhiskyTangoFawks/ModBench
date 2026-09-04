using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>Noggog's small value-vector structs (P2*/P3*) as their named scalar components. Loqui
/// does not model them, so the components are read and written by name-keyed reflection on X/Y/Z.</summary>
internal static class VectorStructLeaves
{
    private static readonly string[] VectorComponentNames = ["X", "Y", "Z"];

    // A fixed name list, not a property walk: every vector type has a self-referencing Point property
    // that would recurse forever. A P2 type simply has no Z, so no count-specific branch is needed.
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

    // xEdit shows OBND's six components individually (wbOBND: X1/Y1/Z1/X2/Y2/Z2), so a nested vector
    // is a struct sub-field, not an atomic leaf.
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
            LeafTypeName: ReflectedTypes.LeafTypeName(core));
    }

    // A vector at the record's top level (Placed*.Position, IslandData.Min/Max). Placement's Position
    // is mirrored into the placement side table with no write-time re-derivation, and
    // RecordEditService.RefuseIfContainmentField guards that path.
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
            SubFieldMetas: subFieldMetas, LeafTypeName: ReflectedTypes.LeafTypeName(core));
    }

    // A vector is a value type, so the write builds or copies the boxed value, applies each component
    // onto the box, and writes the box back onto the enclosing property.
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
