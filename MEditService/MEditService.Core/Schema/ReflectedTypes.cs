using System.Reflection;
using System.Text.RegularExpressions;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;
using Noggog;

namespace MEditService.Core.Schema;

/// <summary>What a CLR type reflected off a Mutagen getter interface <i>is</i>: the structural
/// questions every leaf-kind dispatch asks. Answers only; nothing here builds a column or an applier.</summary>
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

    // A getter interface exposes a non-nullable FormLink as the base IFormLinkGetter<T>; only an
    // explicitly nullable one gets IFormLinkNullableGetter<T>, the one type-level signal to trust.
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

    // A closed, verified set rather than an "any small struct with X/Y/Z" rule, which would also match
    // these types' self-referencing Point property and recurse forever. Noggog's other siblings have
    // no FO4 usages.
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

    /// <summary>The Loqui setter class behind a getter interface, or the type itself where Loqui has
    /// none — the vocabulary a union's discriminator values are drawn from, so a union leaf and a
    /// plain struct name themselves alike.</summary>
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
