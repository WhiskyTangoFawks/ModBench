using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>Noggog's small value-vector structs (P2*/P3*), spelled by the codec as one comma-joined
/// text leaf ("x, y, z"). Loqui does not model them, so a write sets X/Y/Z by name-keyed
/// reflection.</summary>
internal static class VectorStructLeaves
{
    private static readonly string[] VectorComponentNames = ["X", "Y", "Z"];

    // A fixed name list, not a property walk: several vector types carry a self-referencing Point property
    // that would recurse forever. A P2 type simply has no Z, so no count-specific branch is needed.
    private static List<SubFieldSpec> BuildVectorComponentSubFields(
        Type vectorType, GameReflection game, ILogger logger)
    {
        var result = new List<SubFieldSpec>();
        foreach (var name in VectorComponentNames)
        {
            var componentProp = vectorType.GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
            if (componentProp == null) continue;
            if (SubFieldReflection.GetSubFieldInfo(componentProp, game, SubFieldReflection.RootPath, 1, logger) is { } spec)
                result.Add(spec);
        }
        return result;
    }

    internal static Func<object, JsonElement, ApplyOutcome> MakeVectorApplier(
        PropertyInfo prop, Type core, GameReflection game, ILogger logger)
    {
        var components = BuildVectorComponentSubFields(core, game, logger);
        var pName = prop.Name;
        return (obj, json) => ApplyVectorJson(obj, json, pName, core, components);
    }

    /// <summary>The codec's "x, y, z" as the components it names, for a writer that sets them one by
    /// one; an object already keyed by component passes through.</summary>
    internal static JsonElement? AsComponents(JsonElement json)
    {
        if (json.ValueKind == JsonValueKind.Object) return json;
        if (json.ValueKind != JsonValueKind.String) return null;
        var parts = json.GetString()!.Split(',', StringSplitOptions.TrimEntries);
        if (parts.Length is not (2 or 3)) return null;
        var obj = new JsonObject();
        for (var i = 0; i < parts.Length; i++)
        {
            if (!double.TryParse(parts[i], NumberStyles.Float, CultureInfo.InvariantCulture, out var n)) return null;
            obj[VectorComponentNames[i]] = n;
        }
        return JsonSerializer.SerializeToElement(obj);
    }

    // A vector is a value type, so the write builds or copies the boxed value, applies each component
    // onto the box, and writes the box back onto the enclosing property.
    internal static ApplyOutcome ApplyVectorJson(
        object obj, JsonElement json, string pName, Type core, IReadOnlyList<SubFieldSpec> components)
    {
        if (AsComponents(json) is not { } byComponent) return ApplyOutcome.ValueRejected;
        var rp = obj.GetType().GetProperty(pName, BindingFlags.Public | BindingFlags.Instance);
        if (rp == null) return ApplyOutcome.PropertyNotFound;
        var current = rp.GetValue(obj) ?? Activator.CreateInstance(core)!;
        var subOutcome = SubFieldValues.ApplySubFields(current, byComponent, components);
        if (subOutcome != ApplyOutcome.Applied) return subOutcome;
        if (rp.CanWrite) rp.SetValue(obj, current);
        return ApplyOutcome.Applied;
    }

    /// <summary>A list of vectors: each element is built from its own text.</summary>
    internal static IReadOnlyList<SubFieldSpec> ElementComponents(Type vectorType, GameReflection game, ILogger logger) =>
        BuildVectorComponentSubFields(vectorType, game, logger);
}
