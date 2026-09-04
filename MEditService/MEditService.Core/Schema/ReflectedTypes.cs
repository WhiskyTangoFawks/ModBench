using System.Reflection;
using System.Text.RegularExpressions;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;
using Noggog;

namespace MEditService.Core.Schema;

/// <summary>What a CLR type reflected off a Mutagen getter interface <i>is</i> — the structural
/// questions every leaf-kind dispatch asks before it decides how to present a property. Answers only;
/// nothing here builds a column, a sub-field or an applier.</summary>
internal static partial class ReflectedTypes
{
    internal static IEnumerable<PropertyInfo> GetAllInterfaceProperties(Type type) =>
        type.GetInterfaces()
            .Append(type)
            .SelectMany(i => i.GetProperties(BindingFlags.Public | BindingFlags.Instance));

    internal static bool IsTranslatedString(Type type) =>
        typeof(ITranslatedStringGetter).IsAssignableFrom(type);

    internal static bool IsFormLink(Type type) =>
        typeof(IFormLinkGetter).IsAssignableFrom(type);

    // On *Getter interfaces (what SchemaReflector walks), a non-nullable FormLink property is exposed
    // as the ambiguous base IFormLinkGetter<T> — the same static type a nullable property would have
    // if Mutagen didn't bother marking it. Only explicitly-nullable properties get the distinct marker
    // interface IFormLinkNullableGetter<T>, so that's the only type-level signal we can trust.
    internal static bool IsNullableFormLink(Type type) =>
        type.GetInterfaces().Prepend(type).Any(i =>
            i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IFormLinkNullableGetter<>));

    // IReadOnlyList<T> only — that's what Mutagen getter interfaces expose for collections.
    internal static bool IsListType(Type type, out Type elementType)
    {
        elementType = typeof(object);
        if (!type.IsGenericType) return false;
        if (type.GetGenericTypeDefinition() != typeof(IReadOnlyList<>)) return false;
        elementType = type.GetGenericArguments()[0];
        return true;
    }

    // Mutagen Loqui-generated sub-record interfaces always declare a static StaticRegistration.
    internal static bool IsLoquiInterface(Type type) =>
        type.IsInterface &&
        !IsFormLink(type) &&
        type.GetProperty("StaticRegistration", BindingFlags.Public | BindingFlags.Static) != null;

    // Noggog's small value-vector struct family
    // — plain structs (not Loqui interfaces: no StaticRegistration), each with two or three
    // scalar members named X, Y, and optionally Z. Real FO4 examples of each, found by grepping
    // references/Mutagen/Mutagen.Bethesda.Fallout4 rather than assumed: ObjectBounds.First/Second
    // (P3Int16), several top-level fields such as Placed*.Position and IslandData.Min/Max plus
    // several struct sub-fields such as PlacedObject.TeleportDestination.Position/Rotation (P3Float),
    // Cell.Grid.Point (P2Int), WorldspaceMaxHeight.Min/Max and several others, also reachable as a
    // list element on LocationCoordinate.Coordinates (P2Int16), WorldDefaultLevelData's two
    // cell-coord fields (P2UInt8), LandscapeVertexHeightMap.Unknown (P3UInt8),
    // RegionObject.AngleVariance (P3UInt16), and ImageSpaceAdapter.RadialBlurCenter (P2Float).
    // Hardcoded to exactly this verified set — the same "verified, not assumed, small closed set"
    // posture ObjectModPropertyLeaves.LeafInterfaces takes for OMOD's seven — rather than a generic "any
    // struct shaped like a small vector" rule, which would also match several of these types' own
    // self-referencing Point property (P3Int16's own `Point => this` among them) and recurse
    // forever. Noggog's other siblings (P2Double, P3Double, P3Int, the wrapper types ending in
    // Value or Obj) have zero FO4 usages and stay out on that ground.
    private static readonly HashSet<Type> VectorStructTypes =
    [
        typeof(P3Int16), typeof(P3Float),
        typeof(P2Int), typeof(P2UInt8), typeof(P2Int16),
        typeof(P3UInt8), typeof(P3UInt16), typeof(P2Float),
    ];

    internal static bool IsVectorStructType(Type type) => VectorStructTypes.Contains(type);

    internal static bool IsAtomicValueType(Type core) => core == typeof(System.Drawing.Color);

    // Retrieve the concrete mutable class (e.g. RankPlacement) via ILoquiRegistration.SetterType.
    internal static Type? GetSetterType(Type getterInterface)
    {
        var regProp = getterInterface.GetProperty(
            "StaticRegistration", BindingFlags.Public | BindingFlags.Static);
        var reg = regProp?.GetValue(null);
        return reg?.GetType().GetField("ClassType", BindingFlags.Public | BindingFlags.Static)?.GetValue(null) as Type;
    }

    // Mirrors GetSetterType: reads GetterType off a *concrete* Loqui class's own StaticRegistration,
    // rather than SetterType off a getter interface's.
    internal static Type? GetOwnGetterType(Type concreteClass)
    {
        var regProp = concreteClass.GetProperty(
            "StaticRegistration", BindingFlags.Public | BindingFlags.Static);
        var reg = regProp?.GetValue(null);
        return reg?.GetType().GetField("GetterType", BindingFlags.Public | BindingFlags.Static)
            ?.GetValue(null) as Type;
    }

    /// <summary>The class a struct-shaped leaf <i>is</i>: the concrete Loqui Setter class behind a
    /// getter interface (IScriptEntryGetter -> ScriptEntry), or the type itself where Loqui does not
    /// model it (Noggog's P3Float, System.Drawing.Color). The same vocabulary an abstract union's
    /// discriminator values are drawn from, so a union leaf and a plain struct name themselves
    /// alike.</summary>
    internal static string LeafTypeName(Type type)
    {
        var name = (GetSetterType(type) ?? type).Name;
        // A closed generic's CLR name carries its arity (OMOD's own `AObjectModProperty`1`), which
        // is spelling, not identity.
        var arity = name.IndexOf('`', StringComparison.Ordinal);
        return arity < 0 ? name : name[..arity];
    }

    // The type and its bases within its own assembly — a Loqui base is never outside it.
    internal static IEnumerable<Type> BaseChain(Type type)
    {
        for (var t = type; t != null && t.Assembly == type.Assembly; t = t.BaseType) yield return t;
    }

    internal static readonly HashSet<Type> IntegerTypes =
    [
        typeof(byte), typeof(sbyte), typeof(short), typeof(ushort),
        typeof(int), typeof(uint), typeof(long), typeof(ulong),
    ];

    internal static string ToSnakeCase(string name) =>
        SnakeCaseBoundary().Replace(name, "_$1").ToLowerInvariant();

    /// <summary>One property's value off any instance, or null when the accessor throws. Mutagen's
    /// getters throw for a subrecord that is genuinely absent, which is a value, not a defect.</summary>
    internal static object? ReadOrNull(object obj, PropertyInfo prop)
    {
        try { return prop.GetValue(obj); }
        catch { return null; } // Stryker disable once Block: silent accessor — per-call lambdas stay silent to avoid log noise (see MEditService CLAUDE.md)
    }

    /// <summary><see cref="ReadOrNull"/> bound to one property, for a leaf's Extract delegate.</summary>
    internal static Func<object, object?> SubGetter(PropertyInfo prop) => obj => ReadOrNull(obj, prop);

    [GeneratedRegex("(?<=[a-z0-9])([A-Z])")]
    private static partial Regex SnakeCaseBoundary();
}
